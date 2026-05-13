// "My Apps" — the panel listing user-kept copies of `create_artifact` bundles
// (`<uid>/cloud/saved_apps/<appId>/`, written by `features/saved_apps.ts`).
//
// Apps land here only via the chat-bubble artifact card's `⋯` → "Save" (which
// calls `loadSavedApps(true)` afterwards). Clicking a card opens its
// `index.html` in the system browser (`savedApps.openExternal` →
// `shell.openPath`, a `file://` view — same caveats as the artifact card's
// "open in browser": no chat round-trip, and the `__orkas/bridge.js` virtual
// path / cross-origin sibling `fetch` don't work there). The per-card `⋯` menu
// has: open in browser / rename / delete.
//
// Classic script — no import/export. Global `loadSavedApps` is exposed via
// `window.*`. Loaded after `agents.js` in index.html.

(function () {
  const _appsLog = (typeof createLogger === 'function') ? createLogger('saved-apps') : { warn: () => {}, error: () => {} };
  let _appsCache = null; // last fetched list (for the i18n-change re-render)

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
    try {
      const r = await window.orkas.invoke('savedApps.openExternal', { appId: String(appId) });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'open failed');
    } catch (err) { _fail(_t('apps.open_failed', 'Could not open in browser'), err); }
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
    // Add to the sidebar list.
    try {
      if (typeof conversations !== 'undefined' && Array.isArray(conversations)) {
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
        input.value = _t('apps.edit_seed',
          'I want to modify the interactive app "{name}". Its full source is in the attached file "{file}". Please make these changes:\n\n',
          { name, file });
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
          title: _t('apps.delete', 'Delete'),
          message: _t('apps.delete_confirm', 'Delete this app? This cannot be undone.', { name }),
          dangerLabel: _t('apps.delete', 'Delete'),
        });
      } else if (typeof uiConfirm === 'function') {
        ok = await uiConfirm(_t('apps.delete_confirm', 'Delete this app? This cannot be undone.', { name }));
      } else { ok = true; }
    } catch (_) { ok = false; }
    if (!ok) return;
    try {
      const r = await window.orkas.invoke('savedApps.delete', { appId: String(appId) });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'delete failed');
    } catch (err) { _fail(_t('apps.delete_failed', 'Could not delete'), err); }
    loadSavedApps(true);
  }

  // ── render ──────────────────────────────────────────────────────────────
  function _renderApps(apps) {
    const grid = document.getElementById('apps-grid');
    const empty = document.getElementById('apps-empty');
    if (!grid) return;
    grid.innerHTML = '';
    const list = Array.isArray(apps) ? apps : [];
    if (empty) empty.style.display = list.length ? 'none' : '';
    for (const a of list) {
      if (!a || !a.id) continue;
      const card = document.createElement('div');
      card.className = 'app-card';
      card.dataset.appId = a.id;
      card.title = _t('apps.open_hint', 'Open in your default browser');

      const header = document.createElement('div');
      header.className = 'app-card-header';
      const name = document.createElement('span');
      name.className = 'app-card-name';
      name.textContent = a.title || _t('artifact.title', 'Interactive app');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'app-card-more';
      more.dataset.appMore = '1';
      more.textContent = '⋯';
      more.title = _t('apps.more', 'More');
      more.setAttribute('aria-label', _t('apps.more', 'More'));
      header.appendChild(name);
      header.appendChild(more);

      const hint = document.createElement('div');
      hint.className = 'app-card-hint';
      hint.textContent = _t('apps.source_hint', 'From a conversation');

      card.appendChild(header);
      card.appendChild(hint);
      card.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-app-more]')) {
          e.stopPropagation();
          _toggleRowMenu(more, a.id);
          return;
        }
        _openApp(a.id);
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
