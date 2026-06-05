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

  function _track(action, data) {
    
  }

  function _trackError(action, data) {
    
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
          <button type="button" class="saved-app-viewer-close" aria-label="${_esc(closeLabel)}" title="${_esc(closeLabel)}">×</button>
        </div>
        <iframe class="saved-app-viewer-frame" sandbox="allow-scripts allow-same-origin allow-forms" title=""></iframe>
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
      if (!_appViewerFrame || ev.source !== _appViewerFrame.contentWindow) return;
      const data = ev && ev.data;
      if (!data || typeof data !== 'object' || data.__orkasArtifact !== true) return;
      if (String(data.type || '') !== 'open-external') return;
      const url = String(data.url || '').trim();
      if (/^https?:\/\//i.test(url)) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }
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
        _track('saved_app_menu_action', { action, app_id: String(id || '') });
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
    _track('saved_app_open', { app_id: String(appId || '') });
    try {
      const r = await window.orkas.invoke('savedApps.openInApp', { appId: String(appId) });
      if (!r || r.ok === false || !r.url) throw new Error((r && r.error) || 'open failed');
      const app = (_appsCache || []).find((a) => a && a.id === appId);
      _openAppViewer(r.url, (app && app.title) || _t('artifact.title', 'Interactive app'));
    } catch (err) { _trackError('saved_app_open', { app_id: String(appId || ''), msg: String(err && err.message || err) }); _fail(_t('apps.open_failed', 'Could not open the app'), err); }
  }

  // "Edit" — backend creates a fresh conversation with the app's source bundled
  // in as an `app-source.md` attachment; we navigate to it and pre-fill a draft
  // (mirrors `agents.js::useAgent`'s create-conv-and-go pattern, but doesn't
  // auto-send — the user completes the request and hits Send).
  async function _editApp(appId) {
    let r;
    try {
      r = await window.orkas.invoke('savedApps.openForEditing', { appId: String(appId) });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'open-for-editing failed');
    } catch (err) { _fail(_t('apps.edit_failed', 'Could not open an edit conversation'), err); return; }
    const conv = r.conversation;
    if (!conv || !conv.conversation_id) { _fail(_t('apps.edit_failed', 'Could not open an edit conversation')); return; }
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
    } catch (err) { _appsLog.warn('edit post-nav setup failed', err && err.message ? err.message : err); }
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
    try {
      const r = await window.orkas.invoke('savedApps.rename', { appId: String(appId), title: next });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'rename failed');
    } catch (err) { _fail(_t('apps.rename_failed', 'Could not rename'), err); }
    loadSavedApps(true);
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
    try {
      const r = await window.orkas.invoke('savedApps.delete', { appId: String(appId) });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'delete failed');
    } catch (err) { _fail(_t('apps.delete_failed', 'Could not delete'), err); }
    loadSavedApps(true);
  }

  // Short relative formatter for the meta row's "updated" slot.
  // Buckets: <60s → just now; same day → HH:mm; <7d → Nd; else YYYY-MM-DD.
  function _formatRelative(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return _t('common.just_now', 'just now');
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return _t('sidebar.bucket.yesterday', 'Yesterday');
    const days = Math.floor(diffMs / 86_400_000);
    if (days < 7) return `${days}d`;
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
          _track('saved_app_menu_open', { app_id: String(a.id || '') });
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
