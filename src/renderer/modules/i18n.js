// ─── i18n — renderer-side ──────────────────────────────────────────────
//
// Contract:
//   initI18n()                          – called once at boot
//   t(key, vars?)                       – sync lookup, current lang → en → raw key
//   getLang()                           – 'zh' | 'en'
//   setLang(lang)                       – persists via IPC, refreshes DOM,
//                                         dispatches 'i18n-change' on window
//   applyDomI18n(root?)                 – fills [data-i18n] /
//                                         [data-i18n-placeholder] /
//                                         [data-i18n-title] under root (or
//                                         document)
//
// Tables ship under `src/renderer/locales/{zh,en}.json`. We fetch them
// through the IPC bridge (`window.orkas.getLocales`) — avoids fiddling
// with sandbox + file:// fetch rules.
//
// Modules that render content dynamically (list rows, dialog messages
// created on the fly) should register a `window.addEventListener(
// 'i18n-change', handler)` to re-render themselves. HTML that lives in
// index.html is auto-refreshed by `applyDomI18n()`.

const _i18nLog = createLogger('i18n');

let _currentLang = 'en';
let _tables = { zh: {}, en: {} };
let _ready = false;

function _lookup(key, lang) {
  const tbl = _tables[lang];
  return tbl && Object.prototype.hasOwnProperty.call(tbl, key) ? tbl[key] : undefined;
}

function t(key, vars) {
  let raw = _lookup(key, _currentLang);
  if (raw == null && _currentLang !== 'en') raw = _lookup(key, 'en');
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
    if (langRes && langRes.ok && (langRes.language === 'zh' || langRes.language === 'en')) {
      _currentLang = langRes.language;
    }
    if (localesRes && localesRes.ok && localesRes.tables) {
      _tables = {
        zh: localesRes.tables.zh || {},
        en: localesRes.tables.en || {},
      };
    }
  } catch (err) {
    _i18nLog.warn('initI18n failed, using defaults', { error: (err && err.message) || String(err) });
  }
  _ready = true;
  applyDomI18n();
  return _currentLang;
}

async function setLang(lang) {
  if (lang !== 'zh' && lang !== 'en') return _currentLang;
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
