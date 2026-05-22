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
//                                         [data-i18n-title] under root (or
//                                         document)
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
let _tables = {};
let _ready = false;

const _LOCALES = [
  { code: 'zh', label: '简体中文', htmlLang: 'zh-CN', intlLocale: 'zh-CN', fallback: 'en' },
  { code: 'en', label: 'English', htmlLang: 'en', intlLocale: 'en-US', fallback: null },
  { code: 'ja', label: '日本語', htmlLang: 'ja', intlLocale: 'ja-JP', fallback: 'en' },
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
    if (!boot || !boot.tables) return;
    if (isSupportedLang(boot.lang)) _currentLang = boot.lang;
    _tables = boot.tables || {};
    _ready = true;
    applyDomI18n();
    _setDocumentLang(_currentLang);
  } catch (err) {
    _i18nLog.warn('sync i18n boot failed; falling back to async', {
      error: (err && err.message) || String(err),
    });
  }
})();

function _lookup(key, lang) {
  const tbl = _tables[lang];
  return tbl && Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key] : undefined;
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

async function initI18n() {
  if (_ready) return _currentLang;
  try {
    const langRes = await window.orkas.getLanguage();
    const localesRes = await window.orkas.getLocales();
    if (langRes && langRes.ok && isSupportedLang(langRes.language)) {
      _currentLang = langRes.language;
    }
    if (localesRes && localesRes.ok && localesRes.tables) {
      _tables = localesRes.tables || {};
    }
  } catch (err) {
    _i18nLog.warn('initI18n failed, using defaults', { error: (err && err.message) || String(err) });
  }
  _ready = true;
  applyDomI18n();
  _setDocumentLang(_currentLang);
  return _currentLang;
}

async function setLang(lang) {
  if (!isSupportedLang(lang)) return _currentLang;
  if (lang === _currentLang) return _currentLang;
  try {
    const res = await window.orkas.setLanguage(lang);
    if (res && res.ok && res.language) {
      _currentLang = res.language;
    } else {
      _currentLang = lang;
    }
  } catch (err) {
    _i18nLog.warn('setLang persist failed', { error: (err && err.message) || String(err) });
    _currentLang = lang;
  }
  applyDomI18n();
  _setDocumentLang(_currentLang);
  window.dispatchEvent(new CustomEvent('i18n-change', { detail: { lang: _currentLang } }));
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
}
