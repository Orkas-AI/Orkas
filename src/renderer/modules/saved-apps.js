// "My Apps" — the panel listing user-kept copies of `create_artifact` bundles
// (`<uid>/cloud/saved_apps/<appId>/`, written by `features/saved_apps.ts`).
//
// Apps land here via the chat-bubble artifact card's `⋯` → "Save" or via
// "Save as app" on a generated HTML bundle. Clicking a card opens the saved
// bundle in an in-app floating iframe over `chat-app://saved/...`; the per-card
// `⋯` menu has edit / rename / delete.
//
// Classic script — no import/export. Global `loadSavedApps` is exposed via
// `window.*`. Loaded after `agents.js` in index.html.

(function () {
  const artifactSecurity = window.OrkasArtifactSecurity;
  if (!artifactSecurity) throw new Error('artifact-security.js must load before saved-apps.js');
  const _appsLog = (typeof createLogger === 'function') ? createLogger('saved-apps') : { warn: () => {}, error: () => {} };
  let _appsCache = null; // last fetched list (for the i18n-change re-render)
  let _appViewerEl = null;
  let _appViewerFrame = null;
  let _appViewerTitle = null;
  let _appViewerKeyHandler = null;

  function _t(key, fallback, vars) {
    try { if (typeof t === 'function') { const v = t(key, vars); if (v && v !== key) return v; } } catch (_) {}
    // Translation missing — interpolate the fallback ourselves so {vars} still resolve.
    if (vars && typeof fallback === 'string') {
      return fallback.replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m));
    }
    return fallback;
  }

  function _fail(prefix, err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg ? `${prefix}: ${msg}` : prefix);
      else _appsLog.warn(prefix, msg);
    } catch (_) {}
  }

  function _track(action, data) { void action; void data; }
  function _trackError(action, data) { void action; void data; }

  const _SAVED_APP_STABLE_ERROR_CODES = new Set([
    'invalid_response',
    'invalid_title',
    'permission_denied',
    'saved_app_delete_failed',
    'saved_app_edit_failed',
    'saved_app_not_found',
    'saved_app_open_failed',
    'saved_app_rename_failed',
    'saved_app_viewer_failed',
  ]);

  function _savedAppFailureCode(value, fallback) {
    const rawCode = String((value && (value.error_code || value.code)) || '').toLowerCase();
    if (rawCode === 'not_found') return 'saved_app_not_found';
    if (rawCode === 'forbidden') return 'permission_denied';
    if (rawCode === 'bad_input') return 'invalid_response';
    if (_SAVED_APP_STABLE_ERROR_CODES.has(rawCode)) return rawCode;
    const message = String((value && (value.error || value.message)) || value || '').toLowerCase();
    if (/not found|missing (?:its )?html entry/.test(message)) return 'saved_app_not_found';
    if (/outside .*workspace|path traversal|symlink escape|forbidden/.test(message)) return 'permission_denied';
    if (/title required/.test(message)) return 'invalid_title';
    if (/create a conversation|attach .*app source|open.*editing/.test(message)) return 'saved_app_edit_failed';
    if (/rename/.test(message)) return 'saved_app_rename_failed';
    if (/delete/.test(message)) return 'saved_app_delete_failed';
    return _SAVED_APP_STABLE_ERROR_CODES.has(fallback) ? fallback : 'invalid_response';
  }

  function _savedAppFailure(value, fallback, fallbackType = 'operation') {
    const errorCode = _savedAppFailureCode(value, fallback);
    let errorType = fallbackType;
    if (errorCode === 'invalid_response' || errorCode === 'invalid_title') errorType = 'validation';
    else if (errorCode === 'permission_denied') errorType = 'authorization';
    else if (errorCode === 'saved_app_viewer_failed') errorType = 'presentation';
    else if (errorCode === 'saved_app_not_found') errorType = 'operation';
    return { error_type: errorType, error_code: errorCode };
  }

  function _appsLogFailure(action, data) {
    _appsLog.warn('saved app operation failed', { action, ...(data || {}) });
  }

  function _trackManageResult(startedAt, action, result, failure = {}) {
    const payload = {
      result,
      action,
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
    if (result !== 'success') Object.assign(payload, failure);
    if (result === 'failure') {
      _appsLogFailure('saved_app_manage', {
        action,
        error_type: payload.error_type,
        error_code: payload.error_code,
      });
    }
  }

  function _trackOpenResult(startedAt, result, failure = {}) {
    const payload = {
      result,
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
    if (result !== 'success') Object.assign(payload, failure);
    if (result === 'failure') _appsLogFailure('saved_app_open', failure);
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _ensureAppViewer() {
    if (_appViewerEl) return _appViewerEl;
    const closeLabel = _t('chat.preview_close_title', 'Close');
    const root = document.createElement('div');
    root.className = 'saved-app-viewer';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="saved-app-viewer-backdrop"></div>
      <div class="saved-app-viewer-stage">
        <div class="saved-app-viewer-header">
          <span class="saved-app-viewer-title"></span>
          <button type="button" class="modal-close-btn saved-app-viewer-close" aria-label="${_esc(closeLabel)}" title="${_esc(closeLabel)}">${typeof window.uiIconHtml === 'function' ? window.uiIconHtml('x', 'modal-close-icon') : '×'}</button>
        </div>
        <iframe class="saved-app-viewer-frame" sandbox="${artifactSecurity.SANDBOX}" referrerpolicy="no-referrer" title=""></iframe>
      </div>
    `;
    document.body.appendChild(root);
    _appViewerEl = root;
    _appViewerFrame = root.querySelector('.saved-app-viewer-frame');
    _appViewerTitle = root.querySelector('.saved-app-viewer-title');
    root.querySelector('.saved-app-viewer-close').addEventListener('click', _closeAppViewer);
    window.addEventListener('i18n-change', () => {
      if (!_appViewerEl) return;
      const btn = _appViewerEl.querySelector('.saved-app-viewer-close');
      const label = _t('chat.preview_close_title', 'Close');
      if (btn) { btn.setAttribute('aria-label', label); btn.setAttribute('title', label); }
    });
    window.addEventListener('message', (ev) => {
      if (!_appViewerFrame || !artifactSecurity.trustedArtifactMessage(ev, _appViewerFrame)) return;
      const data = ev.data;
      if (String(data.type || '') !== 'open-external') return;
      const url = artifactSecurity.safeExternalHttpUrl(data.url);
      if (url) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }
    });
    return root;
  }

  function _closeAppViewer() {
    if (!_appViewerEl) return;
    _appViewerEl.classList.remove('is-open');
    _appViewerEl.setAttribute('aria-hidden', 'true');
    if (_appViewerFrame) {
      _appViewerFrame.removeAttribute('src');
      _appViewerFrame.setAttribute('title', '');
    }
    if (_appViewerTitle) _appViewerTitle.textContent = '';
    if (_appViewerKeyHandler) {
      document.removeEventListener('keydown', _appViewerKeyHandler);
      _appViewerKeyHandler = null;
    }
  }

  function _openAppViewer(url, title) {
    const root = _ensureAppViewer();
    if (_appViewerTitle) _appViewerTitle.textContent = title || _t('artifact.title', 'Interactive app');
    if (_appViewerFrame) {
      _appViewerFrame.setAttribute('title', title || _t('artifact.title', 'Interactive app'));
      _appViewerFrame.src = url;
    }
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    if (!_appViewerKeyHandler) {
      _appViewerKeyHandler = (e) => {
        if (e.key === 'Escape' && _appViewerEl && _appViewerEl.classList.contains('is-open')) _closeAppViewer();
      };
      document.addEventListener('keydown', _appViewerKeyHandler);
    }
  }

  // ── per-card "⋯" row menu (one shared element, like agents.js) ──────────
  let _rowMenuEl = null;
  let _rowMenuAppId = null;
  let _rowMenuAnchor = null;

  function _closeRowMenu() {
    if (_rowMenuEl) _rowMenuEl.style.display = 'none';
    for (const el of document.querySelectorAll('.app-card.is-menu-open')) el.classList.remove('is-menu-open');
    _rowMenuAppId = null;
    _rowMenuAnchor = null;
  }

  function _ensureRowMenuEl() {
    if (_rowMenuEl) return _rowMenuEl;
    const el = document.createElement('div');
    el.className = 'app-row-menu';
    el.style.display = 'none';
    document.body.appendChild(el);
    document.addEventListener('click', (e) => {
      if (el.style.display === 'none') return;
      if (el.contains(e.target)) return;
      if (e.target && e.target.closest && e.target.closest('[data-app-more]')) return;
      _closeRowMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.style.display !== 'none') _closeRowMenu(); });
    window.addEventListener('scroll', _closeRowMenu, true);
    window.addEventListener('resize', _closeRowMenu);
    window.addEventListener('i18n-change', _closeRowMenu);
    _rowMenuEl = el;
    return el;
  }

  function _positionRowMenu(el, anchorEl) {
    el.style.display = 'block';
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    const rect = anchorEl.getBoundingClientRect();
    const mr = el.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    let left = rect.right - mr.width;
    if (left < margin) left = margin;
    if (left + mr.width > window.innerWidth - margin) left = window.innerWidth - mr.width - margin;
    const below = rect.bottom + gap + mr.height <= window.innerHeight - margin;
    const top = below ? rect.bottom + gap : Math.max(margin, rect.top - mr.height - gap);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function _renderRowMenuItems(el) {
    el.innerHTML = '';
    const defs = [
      ['edit', _t('apps.edit', 'Edit'), false],
      ['rename', _t('apps.rename', 'Rename'), false],
      ['delete', _t('apps.delete', 'Delete'), true],
    ];
    for (const [action, label, danger] of defs) {
      const it = document.createElement('div');
      it.className = 'app-row-menu-item' + (danger ? ' is-danger' : '');
      it.dataset.action = action;
      it.textContent = label;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = _rowMenuAppId;
        _closeRowMenu();
        if (!id) return;
        if (action === 'edit') _editApp(id);
        else if (action === 'rename') _renameApp(id);
        else if (action === 'delete') _deleteApp(id);
      });
      el.appendChild(it);
    }
  }

  function _toggleRowMenu(anchorBtn, appId) {
    const el = _ensureRowMenuEl();
    if (el.style.display !== 'none' && _rowMenuAppId === appId) { _closeRowMenu(); return; }
    _closeRowMenu();
    _rowMenuAppId = appId;
    _rowMenuAnchor = anchorBtn;
    const card = anchorBtn.closest && anchorBtn.closest('.app-card');
    if (card) card.classList.add('is-menu-open');
    _renderRowMenuItems(el);
    _positionRowMenu(el, anchorBtn);
  }

  // ── actions ─────────────────────────────────────────────────────────────
  async function _openApp(appId) {
    const startedAt = Date.now();
    let r;
    try {
      r = await window.orkas.invoke('savedApps.openInApp', { appId: String(appId) });
    } catch (err) {
      _trackOpenResult(startedAt, 'failure', _savedAppFailure(err, 'saved_app_open_failed', 'ipc'));
      _fail(_t('apps.open_failed', 'Could not open the app'), err);
      return;
    }
    if (!r || r.ok === false || !r.url) {
      const failure = _savedAppFailure(r, r && r.ok === false ? 'saved_app_open_failed' : 'invalid_response');
      _trackOpenResult(startedAt, 'failure', failure);
      _fail(_t('apps.open_failed', 'Could not open the app'), { message: (r && r.error) || 'open failed' });
      return;
    }
    try {
      const app = (_appsCache || []).find((a) => a && a.id === appId);
      _openAppViewer(r.url, (app && app.title) || _t('artifact.title', 'Interactive app'));
    } catch (err) {
      _trackError('saved_app_open', { error_message: 'saved_app_open_failed' });
      _fail(_t('apps.open_failed', 'Could not open the app'), err);
      return;
    }
    _trackOpenResult(startedAt, 'success');
  }

  // "Edit" — backend creates a fresh conversation with the app's source bundled
  // in as an `app-source.md` attachment; we navigate to it and pre-fill a draft
  // (mirrors `agents.js::useAgent`'s create-conv-and-go pattern, but doesn't
  // auto-send — the user completes the request and hits Send).
  async function _editApp(appId) {
    const startedAt = Date.now();
    let r;
    try {
      r = await window.orkas.invoke('savedApps.openForEditing', { appId: String(appId) });
    } catch (err) {
      _trackManageResult(startedAt, 'edit', 'failure', _savedAppFailure(err, 'saved_app_edit_failed', 'ipc'));
      _fail(_t('apps.edit_failed', 'Could not open an edit conversation'), err);
      return;
    }
    if (!r || r.ok === false) {
      _trackManageResult(startedAt, 'edit', 'failure', _savedAppFailure(r, 'saved_app_edit_failed'));
      _fail(_t('apps.edit_failed', 'Could not open an edit conversation'), { message: (r && r.error) || 'open-for-editing failed' });
      return;
    }
    const conv = r.conversation;
    if (!conv || !conv.conversation_id) {
      _trackManageResult(startedAt, 'edit', 'failure', _savedAppFailure(r, 'invalid_response'));
      _fail(_t('apps.edit_failed', 'Could not open an edit conversation'));
      return;
    }
    _trackManageResult(startedAt, 'edit', 'success');
    // Add to the sidebar list. Set last_active_at explicitly — backend
    // create response doesn't include the derived field, so timeBucket
    // would otherwise put this brand-new row in the 'older' bucket.
    try {
      if (typeof conversations !== 'undefined' && Array.isArray(conversations)) {
        conv.last_active_at = new Date().toISOString();
        conversations.unshift(conv);
        if (typeof renderConversationList === 'function') renderConversationList();
      }
    } catch (_) {}
    // Navigate (skipLoad — the conv is brand new, nothing to fetch).
    try { setView('conversation', conv.conversation_id, { skipLoad: true }); } catch (_) {}
    // Pre-fill a draft + refresh the attachment chips so `app-source.md` shows
    // (setView with skipLoad doesn't restore drafts or re-sync attachments).
    try {
      const file = r.sourceFileName || 'app-source.md';
      const name = r.title || _t('artifact.title', 'Interactive app');
      const input = document.getElementById('chat-input');
      if (input) {
        const seed = _t('apps.edit_seed',
          'Modify the interactive app "{name}". Source: attached "{file}":',
          { name, file });
        input.value = String(seed || '').trimEnd();
        if (typeof autoGrow === 'function') autoGrow(input, 200);
        if (typeof _saveDraft === 'function') _saveDraft(conv.conversation_id);
        setTimeout(() => { try { input.focus(); } catch (_) {} }, 60);
      }
      if (typeof _chatAttachRefreshFromServer === 'function') _chatAttachRefreshFromServer(conv.conversation_id);
    } catch (_) {
      _appsLogFailure('saved_app_edit_presentation', {
        error_type: 'presentation',
        error_code: 'saved_app_viewer_failed',
      });
    }
  }

  async function _renameApp(appId) {
    const cur = (_appsCache || []).find((a) => a.id === appId);
    let next = null;
    try {
      if (typeof uiPrompt === 'function') next = await uiPrompt(_t('apps.rename_prompt', 'New name:'), (cur && cur.title) || '');
    } catch (_) { next = null; }
    if (next == null) return; // cancelled
    next = String(next).trim();
    if (!next || (cur && next === cur.title)) return;
    const startedAt = Date.now();
    let r;
    try {
      r = await window.orkas.invoke('savedApps.rename', { appId: String(appId), title: next });
    } catch (err) {
      _trackManageResult(startedAt, 'rename', 'failure', _savedAppFailure(err, 'saved_app_rename_failed', 'ipc'));
      _fail(_t('apps.rename_failed', 'Could not rename'), err);
      return;
    }
    if (!r || r.ok === false) {
      _trackManageResult(startedAt, 'rename', 'failure', _savedAppFailure(r, 'saved_app_rename_failed'));
      _fail(_t('apps.rename_failed', 'Could not rename'), { message: (r && r.error) || 'rename failed' });
      return;
    }
    _trackManageResult(startedAt, 'rename', 'success');
    try { loadSavedApps(true); } catch (_) {
      _appsLogFailure('saved_app_refresh', { error_type: 'presentation', error_code: 'saved_app_viewer_failed' });
    }
  }

  async function _deleteApp(appId) {
    const cur = (_appsCache || []).find((a) => a.id === appId);
    const name = (cur && cur.title) || _t('artifact.title', 'Interactive app');
    let ok = false;
    try {
      if (typeof uiConfirmDanger === 'function') {
        ok = await uiConfirmDanger({
          message: _t('apps.delete_confirm', 'Delete "{name}"?', { name }),
          dangerLabel: _t('apps.delete', 'Delete'),
        });
      } else if (typeof uiConfirm === 'function') {
        ok = await uiConfirm(_t('apps.delete_confirm', 'Delete "{name}"?', { name }));
      } else { ok = true; }
    } catch (_) { ok = false; }
    if (!ok) return;
    const startedAt = Date.now();
    let r;
    try {
      r = await window.orkas.invoke('savedApps.delete', { appId: String(appId) });
    } catch (err) {
      _trackManageResult(startedAt, 'delete', 'failure', _savedAppFailure(err, 'saved_app_delete_failed', 'ipc'));
      _fail(_t('apps.delete_failed', 'Could not delete'), err);
      return;
    }
    if (!r || r.ok === false) {
      _trackManageResult(startedAt, 'delete', 'failure', _savedAppFailure(r, 'saved_app_delete_failed'));
      _fail(_t('apps.delete_failed', 'Could not delete'), { message: (r && r.error) || 'delete failed' });
      return;
    }
    _trackManageResult(startedAt, 'delete', 'success');
    try { loadSavedApps(true); } catch (_) {
      _appsLogFailure('saved_app_refresh', { error_type: 'presentation', error_code: 'saved_app_viewer_failed' });
    }
  }

  // Short relative formatter for the meta row's "updated" slot.
  // Buckets: <60s → just now; same day → HH:mm; <7d → Nd; else YYYY-MM-DD.
  function _currentLang() {
    try {
      if (typeof getLang === 'function') return getLang();
    } catch (_) {}
    try {
      return document.documentElement.getAttribute('lang') || navigator.language || 'en';
    } catch (_) {
      return 'en';
    }
  }

  function _relativeTime(value, unit) {
    try {
      return new Intl.RelativeTimeFormat(_currentLang(), { numeric: 'auto' }).format(value, unit);
    } catch (_) {
      if (unit === 'day') return `${Math.abs(value)} days ago`;
      if (unit === 'hour') return `${Math.abs(value)} hours ago`;
      return `${Math.abs(value)} minutes ago`;
    }
  }

  function _formatRelative(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return _t('common.just_now', 'just now');
    if (diffMs < 60 * 60_000) return _relativeTime(-Math.floor(diffMs / 60_000), 'minute');
    if (diffMs < 24 * 60 * 60_000) return _relativeTime(-Math.floor(diffMs / 3_600_000), 'hour');
    const days = Math.floor(diffMs / 86_400_000);
    if (days < 7) return _relativeTime(-Math.max(1, days), 'day');
    const yyyy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mo}-${da}`;
  }

  // ── render ──────────────────────────────────────────────────────────────
  function _renderApps(apps) {
    const grid = document.getElementById('apps-grid');
    const empty = document.getElementById('apps-empty');
    const countEl = document.getElementById('apps-page-header-count');
    if (!grid) return;
    grid.innerHTML = '';
    const list = Array.isArray(apps) ? apps : [];
    if (empty) empty.style.display = list.length ? 'none' : '';
    if (countEl) countEl.textContent = list.length ? String(list.length) : '';

    const moreSvg = (typeof uiIconHtml === 'function')
      ? uiIconHtml('more-horizontal', 'ui-icon app-card-more-icon')
      : '';

    for (const a of list) {
      if (!a || !a.id) continue;
      const title = a.title || _t('artifact.title', 'Interactive app');
      const card = document.createElement('div');
      card.className = 'app-card';
      card.dataset.appId = a.id;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-label', `${title} · ${_t('apps.open_hint', 'Open in Orkas')}`);

      const stripe = document.createElement('span');
      stripe.className = 'app-card-stripe';
      stripe.setAttribute('aria-hidden', 'true');
      card.appendChild(stripe);

      const header = document.createElement('div');
      header.className = 'app-card-header';

      const titleBlock = document.createElement('div');
      titleBlock.className = 'app-card-title-block';

      const name = document.createElement('div');
      name.className = 'app-card-name';
      name.textContent = title;
      titleBlock.appendChild(name);

      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'app-card-more';
      more.dataset.appMore = '1';
      more.innerHTML = moreSvg || '<span aria-hidden="true">...</span>';
      more.title = _t('apps.more', 'More');
      more.setAttribute('aria-label', _t('apps.more', 'More'));

      header.appendChild(titleBlock);
      header.appendChild(more);
      card.appendChild(header);

      // Description paragraph — data layer carries no description field;
      // omit the <p> entirely so the title-row + meta-row collapse tight.
      // (Spec keeps the 3-line clamp CSS so a future field is drop-in.)

      const meta = document.createElement('div');
      meta.className = 'app-card-meta';
      const updated = _formatRelative(a.savedAt);
      if (updated) {
        const u = document.createElement('span');
        u.className = 'app-card-time';
        u.textContent = _t('apps.saved_at_hint', 'Saved {time}', { time: updated });
        meta.appendChild(u);
      }
      card.appendChild(meta);

      card.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-app-more]')) {
          e.stopPropagation();
          _toggleRowMenu(more, a.id);
          return;
        }
        _openApp(a.id);
      });
      card.addEventListener('keydown', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-app-more]')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          _openApp(a.id);
        }
      });
      grid.appendChild(card);
    }
  }

  async function loadSavedApps(_force) {
    // `_force` accepted for parity with loadAgents/loadSkills; this module
    // keeps no "loaded once" flag — the list is cheap, always re-fetch.
    try {
      const r = await window.orkas.invoke('savedApps.list');
      _appsCache = (r && Array.isArray(r.apps)) ? r.apps : [];
    } catch (err) {
      _appsLog.warn('savedApps.list failed', err && err.message ? err.message : err);
      _appsCache = _appsCache || [];
    }
    _renderApps(_appsCache);
  }

  window.addEventListener('i18n-change', () => {
    _closeRowMenu();
    if (_appsCache) _renderApps(_appsCache);
  });

  window.loadSavedApps = loadSavedApps;
})();
