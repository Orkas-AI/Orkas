// ─── i18n — renderer-side ──────────────────────────────────────────────
//
// Contract:
//   initI18n()                          – called once at boot
//   t(key, vars?)                       – sync lookup, current lang → fallback → raw key
//   getLang()                           – current UI language code
//   setLang(lang)                       – persists via IPC, refreshes DOM,
//                                         dispatches 'i18n-change' on window
//   applyDomI18n(root?)                 – fills [data-i18n] /
//                                         [data-i18n-placeholder] /
//                                         [data-i18n-title] /
//                                         [data-i18n-aria-label] under root
//                                         (or document)
//
// Tables ship under `src/renderer/locales/*.json`. The primary delivery
// is a synchronous `ipcRenderer.sendSync('orkas:bootI18n')` in preload, which
// hands the renderer `{lang, tables}` before any DOM script runs — see the
// `_bootSyncI18n` IIFE below. The async `window.orkas.getLocales` /
// `getLanguage` IPC pair remains as a fallback inside `initI18n()` for the
// rare case where preload didn't expose the bundle (handler missing during
// hot reload, contextBridge crash, ...).
//
// Modules that render content dynamically (list rows, dialog messages
// created on the fly) should register a `window.addEventListener(
// 'i18n-change', handler)` to re-render themselves. HTML that lives in
// index.html is auto-refreshed by `applyDomI18n()`.

const _i18nLog = createLogger('i18n');

let _currentLang = 'en';
let _lastPersistedLang = 'en';
let _tables = {};
let _ready = false;
let _languageRequestSeq = 0;
let _languageMutationQueue = Promise.resolve();
let _languageRefreshSeq = 0;

const _LOCALES = [
  { code: 'zh', label: '简体中文', htmlLang: 'zh-CN', intlLocale: 'zh-CN', fallback: 'en' },
  { code: 'en', label: 'English', htmlLang: 'en', intlLocale: 'en-US', fallback: null },
  { code: 'ja', label: '日本語', htmlLang: 'ja', intlLocale: 'ja-JP', fallback: 'en' },
  { code: 'pt', label: 'Português (Brasil)', htmlLang: 'pt-BR', intlLocale: 'pt-BR', fallback: 'en' },
];
const _LOCALE_BY_CODE = _LOCALES.reduce((acc, meta) => {
  acc[meta.code] = meta;
  return acc;
}, {});

function isSupportedLang(lang) {
  return !!_LOCALE_BY_CODE[lang];
}

function getSupportedLanguages() {
  return _LOCALES.map((meta) => ({ ...meta }));
}

function getLocaleMeta(lang) {
  return _LOCALE_BY_CODE[lang] || _LOCALE_BY_CODE.en;
}

function fallbackChain(lang) {
  const out = [];
  const seen = new Set();
  let cur = isSupportedLang(lang) ? lang : 'en';
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = getLocaleMeta(cur).fallback;
  }
  return out;
}

function _setDocumentLang(lang) {
  document.documentElement.setAttribute('lang', getLocaleMeta(lang).htmlLang);
}

function _applyLanguage(lang) {
  if (lang === _currentLang) return _currentLang;
  _currentLang = lang;
  _ready = true;
  applyDomI18n();
  _setDocumentLang(_currentLang);
  window.dispatchEvent(new CustomEvent('i18n-change', { detail: { lang: _currentLang } }));
  return _currentLang;
}

function _normalizeTables(value) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const [lang, rawTable] of Object.entries(value)) {
    if (!isSupportedLang(lang) || !rawTable || typeof rawTable !== 'object' || Array.isArray(rawTable)) {
      continue;
    }
    const table = {};
    for (const [key, raw] of Object.entries(rawTable)) {
      if (typeof raw === 'string') table[key] = raw;
    }
    if (Object.keys(table).length > 0) normalized[lang] = table;
  }
  return normalized;
}

function _hasLanguageTable(lang) {
  const table = _tables[lang];
  return !!table && typeof table === 'object' && Object.keys(table).length > 0;
}

// Synchronous boot path. preload.js does `ipcRenderer.sendSync('orkas:bootI18n')`
// and exposes the result on `window.__orkasI18nBoot` BEFORE any DOM scripts
// run. By the time this script tag executes (index.html line 1118 — after all
// data-i18n elements have been parsed), the table + the user's lang are
// already in hand. Apply translations now and the DOM never paints in the
// wrong language. If the bundle is missing (preload error / handler not
// registered), fall through to the async initI18n() flow below.
(function _bootSyncI18n() {
  try {
    const boot = (typeof window !== 'undefined') ? window.__orkasI18nBoot : null;
    if (!boot || !boot.tables || !isSupportedLang(boot.lang)) return;
    const tables = _normalizeTables(boot.tables);
    if (!tables[boot.lang]) return;
    _currentLang = boot.lang;
    _lastPersistedLang = boot.lang;
    _tables = tables;
    _ready = true;
    applyDomI18n();
    _setDocumentLang(_currentLang);
  } catch (err) {
    _i18nLog.warn('sync i18n boot failed; falling back to async');
  }
})();

function _lookup(key, lang) {
  const tbl = _tables[lang];
  const value = tbl && Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function t(key, vars) {
  let raw;
  for (const lang of fallbackChain(_currentLang)) {
    raw = _lookup(key, lang);
    if (raw != null) break;
  }
  if (raw == null) raw = key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
}

function getLang() { return _currentLang; }

async function _ensureLanguageTable(lang) {
  if (_hasLanguageTable(lang)) return;
  const localesRes = await window.orkas.getLocales();
  if (localesRes && localesRes.ok && localesRes.tables) {
    _tables = { ..._tables, ..._normalizeTables(localesRes.tables) };
  }
  if (!_hasLanguageTable(lang)) throw new Error('language table unavailable');
}

async function initI18n() {
  if (_ready) return _currentLang;
  let langRes = null;
  let localesRes = null;
  try {
    [langRes, localesRes] = await Promise.all([
      window.orkas.getLanguage().catch(() => null),
      window.orkas.getLocales().catch(() => null),
    ]);
  } catch {
    // Defensive only: each request is already converted to null above.
  }
  if (localesRes && localesRes.ok && localesRes.tables) {
    _tables = { ..._tables, ..._normalizeTables(localesRes.tables) };
  }
  const next = langRes && langRes.ok && isSupportedLang(langRes.language)
    ? langRes.language
    : _currentLang;
  if (!_hasLanguageTable(next)) {
    _i18nLog.warn('initI18n failed; preserving default document copy');
    _setDocumentLang(_currentLang);
    return _currentLang;
  }
  _currentLang = next;
  _lastPersistedLang = next;
  _ready = true;
  applyDomI18n();
  _setDocumentLang(_currentLang);
  return _currentLang;
}

async function _persistLanguageChoice(lang, requestSeq) {
  try {
    await _ensureLanguageTable(lang);
    const res = await window.orkas.setLanguage(lang);
    if (!res || !res.ok || res.language !== lang) {
      throw new Error('language persistence rejected');
    }
  } catch {
    if (requestSeq !== _languageRequestSeq) return _currentLang;
    if (
      _lastPersistedLang !== _currentLang
      && _hasLanguageTable(_lastPersistedLang)
    ) {
      _applyLanguage(_lastPersistedLang);
    }
    _i18nLog.warn('language change failed; keeping previous language');
    throw new Error('language change failed');
  }
  _lastPersistedLang = lang;
  if (requestSeq !== _languageRequestSeq) return _currentLang;
  return _applyLanguage(lang);
}

function setLang(lang) {
  if (!isSupportedLang(lang)) return Promise.resolve(_currentLang);
  const requestSeq = ++_languageRequestSeq;
  const run = _languageMutationQueue.then(() => _persistLanguageChoice(lang, requestSeq));
  _languageMutationQueue = run.catch(() => undefined);
  return run;
}

async function refreshLangFromMain() {
  const refreshSeq = ++_languageRefreshSeq;
  const localRequestSeq = _languageRequestSeq;
  const isCurrentRequest = () => (
    refreshSeq === _languageRefreshSeq
    && localRequestSeq === _languageRequestSeq
  );
  try {
    // If a local Settings choice was already queued, observe Main only after
    // that persistence settles. A choice that starts later invalidates this
    // refresh through _languageRequestSeq.
    await _languageMutationQueue;
    if (!isCurrentRequest()) return _currentLang;
    const res = await window.orkas.getLanguage();
    if (!isCurrentRequest()) return _currentLang;
    const next = res && res.ok && isSupportedLang(res.language) ? res.language : _currentLang;
    if (next === _currentLang) return _currentLang;
    await _ensureLanguageTable(next);
    if (!isCurrentRequest()) return _currentLang;
    _lastPersistedLang = next;
    _applyLanguage(next);
  } catch {
    if (isCurrentRequest()) {
      _i18nLog.warn('refreshLangFromMain failed; keeping previous language');
    }
  }
  return _currentLang;
}

// Fill text / placeholder / title for elements tagged with data-i18n*.
// Safe to call multiple times and on subtrees (e.g. after inserting a new
// dialog). Text content is written as plain text — keys that need rich
// markup should compose it in JS using `t()`.
function applyDomI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria-label');
    if (key) el.setAttribute('aria-label', t(key));
  });
}
