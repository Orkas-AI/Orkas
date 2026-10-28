// Chat-bubble interactive web-app artifact widget.
//
// Renders an `artifacts[]` entry from a GroupMessage as a card containing a
// sandboxed `<iframe>` whose `src` is the `chat-app://` protocol (served by
// the main process out of `<uid>/cloud/chat_artifacts/<cid>/<id>/`). The
// artifact is a self-contained web app the LLM produced via `create_artifact`.
//
// Round-trip: the artifact talks to the chat by posting to its parent —
//   parent.postMessage({ __orkasArtifact: true, type: 'submit'|'resize'|'open-external', ... }, '*')
// A single global `message` listener (registered once) validates that
// `event.source` is one of our live artifact iframes, its origin matches
// the registered chat-app origin (even after iframe navigation), and that
// `event.data.__orkasArtifact === true`, then:
//   - `submit` / `sendToChat` → compose a user message (readable summary +
//     `<artifact-result>` machine tag, `@`-routed to the creating actor) and
//     fire it through the normal send pipeline.
//   - `resize` → set the iframe's height (cross-origin, so the parent can't
//     measure the content itself; the artifact reports it, optionally via the
//     `__orkas/bridge.js` helper).
//   - `open-external` → open an http(s) URL outside the artifact iframe.
// We never expose `window.orkas` or any privileged handle into the iframe.
//
// Classic script — no import/export; globals `renderChatArtifact`,
// `encodeArtifactResult` are exposed via `window.*` (matching `chat-input-form.js`).
// Loaded after `conversation.js` in index.html so it can call
// `sendInCurrentConversation` / read `currentCid` directly.

(function () {
  // Canonical source is `ARTIFACT_FRAME` in main/features/chat_artifacts.ts —
  // `create_artifact`'s pre-exposure smoke validates against these exact
  // numbers, so the two must not drift. `chat-artifact-frame-contract.test.ts`
  // pins them together.
  const DEFAULT_FRAME_HEIGHT = 420;   // px, until the artifact reports its own
  const MAX_FRAME_HEIGHT = 640;       // px, clamp; the iframe scrolls past this
  const MIN_FRAME_HEIGHT = 80;        // px
  const artifactSecurity = window.OrkasArtifactSecurity;
  if (!artifactSecurity) throw new Error('artifact-security.js must load before chat-artifact.js');
  const SANDBOX = artifactSecurity.SANDBOX;
  // `allow-same-origin` is safe: the artifact's origin (`chat-app://cid`) is
  // never the renderer's (`file://...`), so the same-origin policy already
  // blocks `parent.*` — the flag only lets the artifact keep a usable origin
  // for localStorage / same-origin sibling fetch. We deliberately omit
  // `allow-popups` / `allow-top-navigation`.

  function _t(key, fallback, vars) {
    try { if (typeof t === 'function') { const v = t(key, vars); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _notifyFail(prefix) {
    try { if (typeof uiAlert === 'function') uiAlert(prefix); } catch (_) {}
  }

  // Card-header "⋯" popover state. One shared menu element appended to <body>,
  // positioned to whichever ⋯ button opened it (same pattern as the agents /
  // contexts row menus); the acting context is stashed per-open.
  let _menuEl = null;
  let _menuCtx = null;     // { frame, cid, artifactId, title } of the open menu
  let _menuAnchor = null;

  function _logArtifactFailure(action, data) {
    try { _convLog.warn('chat artifact operation failed', { action, ...(data || {}) }); } catch (_) {}
  }

  function _artifactSaveFailure(value, fallbackType = 'operation') {
    const message = String((value && (value.error || value.message)) || value || '').toLowerCase();
    let errorCode = 'artifact_save_failed';
    if (/not found/.test(message)) errorCode = 'artifact_not_found';
    else if (/outside .*workspace|path traversal|forbidden/.test(message)) errorCode = 'permission_denied';
    else if (!value) errorCode = 'invalid_response';
    let errorType = fallbackType;
    if (errorCode === 'invalid_response') errorType = 'validation';
    else if (errorCode === 'permission_denied') errorType = 'authorization';
    else if (errorCode === 'artifact_not_found') errorType = 'operation';
    return { error_type: errorType, error_code: errorCode };
  }


  function _logArtifactSaveFailure(failure) {
    _logArtifactFailure('artifact_save', failure);
  }
  let _viewerEl = null;
  let _viewerFrame = null;
  let _viewerTitle = null;
  let _viewerKeyHandler = null;

  function _clampHeight(px) {
    const n = Number(px);
    if (!isFinite(n) || n <= 0) return DEFAULT_FRAME_HEIGHT;
    return Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.round(n)));
  }

  // ── result encoding (shared shape with the agent's parser; see the
  //    `create_artifact` tool description for the contract) ───────────────
  // Renders a one-line readable summary + the `<artifact-result>` machine tag
  // routed `@`-style to the creating actor. The tag is stripped from the
  // user bubble's display by `_stripArtifactResultTagForDisplay` in
  // conversation.js; the agent reads the JSON from it.
  function encodeArtifactResult(artifactId, agentId, title, payload) {
    let json = '';
    try { json = JSON.stringify(payload); } catch (_) { json = '"<unserialisable>"'; }
    if (typeof json !== 'string') json = String(json);
    // JSON Unicode escapes preserve values while keeping payload text inside its tag.
    json = json.replace(/</g, '\\u003c');
    const aid = String(agentId || '').trim();
    // commander / unknown → no @-mention (a plain user message goes to the
    // commander by default); a real agent id gets `@<id>` so the bus routes
    // the result back to it (`buildMention` on the backend resolves the raw
    // id when the display name isn't known).
    const mention = (aid && aid !== 'commander') ? `@${aid} ` : '';
    const summary = `${_t('artifact.result_prefix', 'Result from')} "${String(title || _t('artifact.title', 'Interactive app'))}"`;
    const tag = `<artifact-result artifact_id="${String(artifactId || '')}" agent_id="${aid}">\n${json}\n</artifact-result>`;
    return `${mention}${summary}\n\n${tag}`;
  }

  // ── the single global message listener ──────────────────────────────────
  function _findArtifactFrame(sourceWin) {
    if (!sourceWin) return null;
    const frames = document.querySelectorAll('iframe.chat-artifact-frame');
    for (const f of frames) {
      try { if (f.contentWindow === sourceWin) return f; } catch (_) { /* cross-origin access can throw — skip */ }
    }
    return null;
  }

  let _listenerBound = false;
  function _bindGlobalListener() {
    if (_listenerBound) return;
    _listenerBound = true;
    window.addEventListener('i18n-change', () => {
      for (const tag of document.querySelectorAll('.chat-artifact-header .chat-app-type-tag')) {
        _updateAppTypeTag(tag, tag.dataset.appType);
      }
    });
    window.addEventListener('message', async (ev) => {
      const frame = _findArtifactFrame(ev.source);
      if (!frame || !artifactSecurity.trustedArtifactMessage(ev, frame)) return;
      const data = ev.data;
      const cid = frame.dataset.artifactCid || '';
      const artifactId = frame.dataset.artifactId || '';
      const agentId = frame.dataset.artifactAgent || '';
      const title = frame.dataset.artifactTitle || '';
      const type = String(data.type || '');
      if (window.OrkasWebAppHost.isManaged(frame) && !['resize', 'submit', 'sendToChat'].includes(type)) return;
      if (type === 'resize') {
        if (frame.classList && frame.classList.contains('chat-artifact-viewer-frame')) return;
        frame.style.height = `${_clampHeight(data.height)}px`;
        return;
      }
      if (type === 'open-external') {
        const url = artifactSecurity.safeExternalHttpUrl(data.url);
        if (url) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }
        return;
      }
      if (type === 'submit' || type === 'sendToChat') {
        // Only the currently-viewed conversation has live iframes in the DOM,
        // but guard anyway — a result for a non-current cid is a stale fire.
        if (!cid || cid !== currentCid) return;
        try {
          if (window.OrkasWebAppHost.isManaged(frame) && !await window.OrkasWebAppHost.canSubmitArtifact(frame)) return;
          // An async lifetime check must not redirect a result after a task switch or reload.
          if (!frame.isConnected || cid !== currentCid || frame.dataset.artifactCid !== cid
            || frame.dataset.artifactId !== artifactId || !artifactSecurity.trustedArtifactMessage(ev, frame)) return;
          const text = encodeArtifactResult(artifactId, agentId, title, data.payload);
          await sendInCurrentConversation(text);
        }
        catch (err) { try { _convLog.warn('artifact result send failed', err && err.message ? err.message : err); } catch (_) {} }
        return;
      }
      // Unknown type — ignore (forward-compat).
    });
  }

  function _esc(s) {
    try { if (typeof escapeHtml === 'function') return escapeHtml(String(s || '')); } catch (_) {}
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _closeViewer() {
    if (!_viewerEl) return;
    _viewerEl.classList.remove('is-open');
    if (_viewerFrame) {
      window.OrkasWebAppHost.release(_viewerFrame);
      _viewerFrame.removeAttribute('src');
      _viewerFrame.removeAttribute('title');
      _viewerFrame.dataset.artifactCid = '';
      _viewerFrame.dataset.artifactId = '';
      _viewerFrame.dataset.artifactAgent = '';
      _viewerFrame.dataset.artifactTitle = '';
    }
    if (_viewerKeyHandler) {
      document.removeEventListener('keydown', _viewerKeyHandler);
      _viewerKeyHandler = null;
    }
    window.OrkasPreviewHost?.close();
  }

  function _ensureViewer() {
    if (_viewerEl) return _viewerEl;
    const el = document.createElement('div');
    el.className = 'chat-artifact-viewer';
    el.innerHTML = `
      <div class="chat-artifact-viewer-backdrop"></div>
      <div class="chat-artifact-viewer-stage" role="dialog" aria-modal="true">
        <div class="chat-artifact-viewer-header">
          <div class="chat-artifact-viewer-title"></div>
          <div class="chat-file-viewer-actions">
            <button type="button" class="chat-file-viewer-save-app chat-artifact-viewer-save" disabled>${window.uiIconHtml('layout-grid', 'chat-file-viewer-save-app-icon')}</button>
            <button type="button" class="chat-file-viewer-save-new-app chat-artifact-viewer-save-new" hidden>${window.uiIconHtml('plus', 'chat-file-viewer-save-app-icon')}</button>
            <button type="button" class="modal-close-btn chat-artifact-viewer-close">${window.uiIconHtml('x', 'modal-close-icon')}</button>
          </div>
        </div>
        <iframe class="chat-artifact-viewer-frame chat-artifact-frame" sandbox="${SANDBOX}" referrerpolicy="no-referrer"></iframe>
      </div>`;
    document.body.appendChild(el);
    _viewerEl = el;
    _viewerFrame = el.querySelector('.chat-artifact-viewer-frame');
    _viewerTitle = el.querySelector('.chat-artifact-viewer-title');
    const updateLabels = () => {
      for (const [action, key, fallback] of [
        ['save', el.dataset.hasSaveTarget === 'true' ? 'apps.update_original' : 'artifact.menu_save', 'Save as app'],
        ['save-new', 'apps.save_new', 'Save new app'],
        ['close', 'common.close', 'Close'],
      ]) {
        const button = el.querySelector(`.chat-artifact-viewer-${action}`);
        const label = _t(key, fallback);
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.dataset.tooltip = label;
      }
    };
    el._updateSaveLabels = updateLabels;
    updateLabels();
    window.addEventListener('i18n-change', updateLabels);
    el.querySelector('.chat-artifact-viewer-close')?.addEventListener('click', _closeViewer);
    for (const action of ['save', 'save-new']) {
      el.querySelector('.chat-artifact-viewer-' + action).addEventListener('click', async () => {
        const save = el.querySelector('.chat-artifact-viewer-save');
        const copy = el.querySelector('.chat-artifact-viewer-save-new');
        if (save.disabled || !_viewerFrame?.dataset.artifactId) return;
        const ctx = {cid:_viewerFrame.dataset.artifactCid, artifactId:_viewerFrame.dataset.artifactId,
          saveMode:action === 'save-new' ? 'new' : el.dataset.hasSaveTarget === 'true' ? 'update' : 'auto'};
        save.disabled = copy.disabled = true;
        try { await _doSave(ctx); }
        finally { await _refreshViewerSaveActions(); }
      });
    }
    return el;
  }

  async function _refreshViewerSaveActions() {
    if (!_viewerEl || !_viewerFrame) return;
    const cid = _viewerFrame.dataset.artifactCid, artifactId = _viewerFrame.dataset.artifactId;
    const save = _viewerEl.querySelector('.chat-artifact-viewer-save');
    const copy = _viewerEl.querySelector('.chat-artifact-viewer-save-new');
    save.disabled = copy.disabled = true;
    let target = null;
    try { target = (await window.orkas.invoke('conversations.artifacts.editTarget', {cid,artifactId}))?.target; }
    catch (_) { /* Saving still validates the source at the owning boundary. */ }
    if (cid !== _viewerFrame.dataset.artifactCid || artifactId !== _viewerFrame.dataset.artifactId) return;
    _viewerEl.dataset.hasSaveTarget = String(!!target);
    copy.hidden = !target;
    _viewerEl._updateSaveLabels();
    save.disabled = copy.disabled = false;
  }

  async function _openViewer(ctx) {
    if (!ctx || !ctx.cid || !ctx.artifactId) return;
    if (window.OrkasPreviewWindows) {
      const result = await window.OrkasPreviewWindows.open({ kind: 'artifact', cid: ctx.cid, artifactId: ctx.artifactId, agentId: ctx.agentId || '', title: ctx.title || _t('artifact.title', 'Interactive app') });
      return result;
    }
    _bindGlobalListener();
    const el = _ensureViewer();
    const title = ctx.title || _t('artifact.title', 'Interactive app');
    if (_viewerTitle) _viewerTitle.textContent = title;
    if (_viewerFrame) {
      _viewerFrame.dataset.artifactCid = String(ctx.cid);
      _viewerFrame.dataset.artifactId = String(ctx.artifactId);
      _viewerFrame.dataset.artifactAgent = String(ctx.agentId || '');
      _viewerFrame.dataset.artifactTitle = title;
      _viewerFrame.dataset.appType = '';
      _viewerFrame.setAttribute('title', title);
      window.OrkasWebAppHost.open(_viewerFrame, { cid: ctx.cid, artifactId: ctx.artifactId });
      _checkArtifactAvailability(_viewerFrame, ctx);
      _refreshViewerSaveActions();
    }
    el.classList.add('is-open');
    if (!_viewerKeyHandler) {
      _viewerKeyHandler = (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Escape') _closeViewer(); };
      document.addEventListener('keydown', _viewerKeyHandler);
    }
  }

  // ── card-header "⋯" menu (reload / open / save) ────────────────────────
  function _closeMenu() {
    if (_menuEl) _menuEl.style.display = 'none';
    if (_menuAnchor) _menuAnchor.classList.remove('is-menu-open');
    _menuCtx = null;
    _menuAnchor = null;
  }

  function _ensureMenuEl() {
    if (_menuEl) return _menuEl;
    const el = document.createElement('div');
    el.className = 'chat-artifact-menu';
    el.style.display = 'none';
    document.body.appendChild(el);
    document.addEventListener('click', (e) => {
      if (el.style.display === 'none') return;
      if (el.contains(e.target)) return;
      if (e.target && e.target.closest && e.target.closest('.chat-artifact-more')) return;
      _closeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Escape' && el.style.display !== 'none') _closeMenu(); });
    window.addEventListener('scroll', _closeMenu, true);
    window.addEventListener('resize', _closeMenu);
    window.addEventListener('i18n-change', _closeMenu);
    _menuEl = el;
    return el;
  }

  // Rebuilt on every open — items are fixed; doing it here keeps labels fresh
  // after an `i18n-change` without re-binding gymnastics.
  function _renderMenuItems(el) {
    el.innerHTML = '';
    const defs = [
      ['reload', _t('artifact.reload', 'Reload')],
      ['open', _t('artifact.open_external', 'Open')],
      ['save', _t('artifact.menu_save', 'Save')],
    ];
    for (const [action, label] of defs) {
      const it = document.createElement('div');
      it.className = 'chat-artifact-menu-item';
      it.dataset.action = action;
      it.textContent = label;
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        const ctx = _menuCtx;
        _closeMenu();
        if (!ctx) return;
        if (action === 'reload') _doReload(ctx);
        else if (action === 'open') _doOpen(ctx);
        else if (action === 'save') _doSave(ctx);
      });
      el.appendChild(it);
    }
  }

  function _positionMenu(el, anchorEl) {
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

  async function _openMenu(anchorBtn, ctx) {
    const el = _ensureMenuEl();
    if (el.style.display !== 'none' && _menuAnchor === anchorBtn) { _closeMenu(); return; }
    _closeMenu();
    delete ctx.saveMode;
    _menuCtx = ctx;
    _menuAnchor = anchorBtn;
    anchorBtn.classList.add('is-menu-open');
    await _checkArtifactAvailability(ctx.frame, ctx);
    if (_menuCtx !== ctx || _menuAnchor !== anchorBtn) return;
    _renderMenuItems(el);
    _positionMenu(el, anchorBtn);
    try {
      const result = await window.orkas.invoke('conversations.artifacts.editTarget', { cid: String(ctx.cid), artifactId: String(ctx.artifactId) });
      if (result?.target && _menuCtx === ctx && el.style.display !== 'none') {
        const save = el.querySelector('[data-action="save"]');
        ctx.saveMode = 'new';
        if (save) save.textContent = _t('apps.save_new', 'Save new app');
        const update = document.createElement('div');update.className='chat-artifact-menu-item';update.dataset.action='update';
        update.textContent=_t('apps.update_original', 'Update original app');update.title=result.target.title;
        update.onclick=event=>{event.stopPropagation();_closeMenu();_doSave({...ctx,saveMode:'update'});};
        if (save) el.insertBefore(update,save);else el.appendChild(update);
      }
    } catch (_) { /* Older hosts preserve the existing Save action. */ }
    if (_menuCtx === ctx && _menuAnchor === anchorBtn) _positionMenu(el, anchorBtn);
  }

  function _clearArtifactUnavailable(frame) {
    if (!frame) return;
    const panel = frame._orkasUnavailablePanel;
    if (panel && panel.remove) panel.remove();
    frame._orkasUnavailablePanel = null;
    frame.style.display = 'block';
  }

  function _showArtifactUnavailable(frame, reason, retry) {
    if (!frame || !frame.parentNode) return;
    let panel = frame._orkasUnavailablePanel;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'chat-artifact-unavailable';
      frame._orkasUnavailablePanel = panel;
      frame.parentNode.insertBefore(panel, frame.nextSibling);
    }
    panel.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'chat-artifact-unavailable-title';
    title.textContent = retry ? _t('artifact.open_failed', 'Could not open') : _t('artifact.unavailable_title', 'App content incomplete');
    const detail = document.createElement('div');
    detail.className = 'chat-artifact-unavailable-detail';
    detail.textContent = _t('artifact.unavailable_detail', 'This saved app only retains a summarized conversation record, not the complete app. Regenerate the app to preview it.');
    panel.appendChild(title);
    if (!retry) panel.appendChild(detail);
    if (retry) {
      const button = document.createElement('button');
      button.className = 'btn btn-sm';
      button.type = 'button';
      button.textContent = _t('artifact.reload', 'Reload');
      button.addEventListener('click', retry);
      const actions = document.createElement('div');
      actions.className = 'header-actions';
      actions.appendChild(button);
      panel.appendChild(actions);
    }
    if (reason) panel.title = String(reason);
    frame.removeAttribute('src');
    frame.style.display = 'none';
  }

  function _updateAppTypeTag(tag, type) {
    if (!tag) return;
    tag.hidden = true;
    tag.textContent = '';
  }

  async function _checkArtifactAvailability(frame, ctx) {
    if (!frame || !ctx || !ctx.cid || !ctx.artifactId) return;
    if (!window.orkas || typeof window.orkas.invoke !== 'function') return;
    const inspection = {};
    frame._orkasInspection = inspection;
    const expectedCid = String(ctx.cid);
    const expectedArtifactId = String(ctx.artifactId);
    try {
      const r = await window.orkas.invoke('conversations.artifacts.inspect', {
        cid: expectedCid,
        artifactId: expectedArtifactId,
      });
      if (!frame.isConnected || frame._orkasInspection !== inspection) return;
      if (frame.dataset.artifactCid !== expectedCid || frame.dataset.artifactId !== expectedArtifactId) return;
      if (frame._orkasLoadFailed) return;
      if (r && r.ok === true && r.status === 'unavailable') {
        frame.dataset.appType = '';
        _updateAppTypeTag(frame.parentNode?.querySelector('.chat-app-type-tag'), '');
        _showArtifactUnavailable(frame, r.reason || '');
      } else if (r && r.ok === true && r.status === 'ok') {
        frame.dataset.appType = r.appType || '';
        _clearArtifactUnavailable(frame);
        _updateAppTypeTag(frame.parentNode?.querySelector('.chat-app-type-tag'), r.appType);
      }
    } catch (err) {
      _logArtifactFailure('artifact_inspect', { error_code: 'artifact_operation_failed' });
    }
  }

  function _doReload(ctx) {
    const f = ctx && ctx.frame;
    if (!f || !f.isConnected) return;
    // A reopened SDK instance has a new isolated origin. Start a fresh frame
    // document so the old app's navigation guard keeps rejecting cross-app
    // navigation; the card and its app/storage identity stay unchanged.
    _clearArtifactUnavailable(f);
    const next = f.cloneNode(false);
    next.removeAttribute('src');
    next.style.height = `${DEFAULT_FRAME_HEIGHT}px`;
    _bindArtifactLoadFailure(next, ctx);
    window.OrkasWebAppHost.release(f);
    f.parentNode.replaceChild(next, f);
    if (f === _viewerFrame) _viewerFrame = next;
    if (_menuCtx?.frame === f) _menuCtx.frame = next;
    window.OrkasWebAppHost.open(next, { cid: ctx.cid, artifactId: ctx.artifactId });
    _checkArtifactAvailability(next, ctx);
  }

  function _bindArtifactLoadFailure(frame, ctx) {
    frame.addEventListener('orkas-app-error', event => {
      event.preventDefault();
      frame._orkasLoadFailed = true;
      _showArtifactUnavailable(frame, '', () => _doReload({ ...ctx, frame }));
    });
  }

  async function _doOpen(ctx) {
    try { await _openViewer(ctx); }
    catch (err) { _logArtifactFailure('artifact_open_viewer', { error_code: 'artifact_operation_failed' }); _notifyFail(_t('artifact.open_failed', 'Could not open'), err); }
  }

  async function _doSave(ctx) {


    let r;
    try {
      r = await window.OrkasAppSave.save('conversations.artifacts.save', {
        cid: String(ctx.cid), artifactId: String(ctx.artifactId), mode: ctx.saveMode || 'auto',
      }, _t);
      if (r?.canceled) {
        return;
      }
    } catch (err) {
      const failure = _artifactSaveFailure(err, 'ipc');

      _logArtifactSaveFailure(failure);
      _notifyFail(_t('apps.save_failed', 'Could not save the app'), err);
      return;
    }
    if (!r || r.ok === false) {
      const failure = _artifactSaveFailure(r, 'operation');

      _logArtifactSaveFailure(failure);
      const recovery = r?.code === 'app_type_mismatch'
        ? _t('apps.save_type_mismatch', 'This version is a different app type from the original app, so it can’t replace it. Save it as a new app instead.')
        : r?.code === 'app_edit_conflict' || r?.code === 'app_edit_target_missing'
        ? _t('apps.edit_conflict', 'The original app changed or was deleted. Reopen it to edit, or save a new app.') : (r && r.error) || '';
      _notifyFail(_t('apps.save_failed', 'Could not save the app'), { message: recovery });
      return;
    }


    try {
      const name = r.title || ctx.title || _t('artifact.title', 'Interactive app');
      const message = ctx.saveMode === 'update'
        ? _t('apps.updated_toast', `Updated ${name}`, { name })
        : _t('apps.saved_toast', 'Saved to Apps');
      if (typeof uiToast === 'function') uiToast(message, { variant: 'success' });
      else if (typeof uiAlert === 'function') uiAlert(message);
      // Refresh the "My Apps" tab if its module is loaded.
      if (window.OrkasPreviewHost) window.OrkasPreviewHost.filesChanged();
      else if (typeof loadSavedApps === 'function') loadSavedApps(true);
    } catch (_) {
      _logArtifactSaveFailure({
        error_type: 'presentation',
        error_code: 'artifact_save_presentation_failed',
      });
    }
  }

  // ── render ──────────────────────────────────────────────────────────────
  // host: a container element appended inside the bubble.
  // ctx:  { cid, artifactId, title, agentId }
  function renderChatArtifact(host, ctx) {
    if (!host || !ctx || !ctx.cid || !ctx.artifactId) return;
    _bindGlobalListener();
    const title = ctx.title || _t('artifact.title', 'Interactive app');

    const card = document.createElement('div');
    card.className = 'chat-artifact-card';

    const header = document.createElement('div');
    header.className = 'chat-artifact-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'chat-artifact-title';
    titleEl.textContent = title;
    titleEl.title = title;
    const typeTag = document.createElement('span');
    typeTag.className = 'conv-status-badge chat-app-type-tag';
    typeTag.hidden = true;
    const spacer = document.createElement('span');
    spacer.className = 'chat-artifact-spacer';
    // All header actions live behind a single "⋯" popover (reload / open /
    // save) — keeps the bubble chrome quiet. See `_openMenu`.
    const moreBtn = document.createElement('button');
    moreBtn.className = 'btn btn-sm chat-artifact-more';
    moreBtn.type = 'button';
    moreBtn.textContent = '⋯';
    moreBtn.title = _t('artifact.more', 'More');
    moreBtn.setAttribute('aria-label', _t('artifact.more', 'More'));
    header.appendChild(titleEl);
    header.appendChild(typeTag);
    header.appendChild(spacer);
    header.appendChild(moreBtn);

    const frame = document.createElement('iframe');
    frame.className = 'chat-artifact-frame';
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.dataset.artifactCid = String(ctx.cid);
    frame.dataset.artifactId = String(ctx.artifactId);
    frame.dataset.artifactAgent = String(ctx.agentId || '');
    frame.dataset.artifactTitle = title;
    frame.dataset.artifactRevision = String(ctx.revision || 0);
    frame.style.height = `${DEFAULT_FRAME_HEIGHT}px`;
    _bindArtifactLoadFailure(frame, ctx);
    window.OrkasWebAppHost.open(frame, { cid: ctx.cid, artifactId: ctx.artifactId });

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentFrame = card.querySelector('iframe.chat-artifact-frame');
      _openMenu(moreBtn, { frame: currentFrame, cid: ctx.cid, artifactId: ctx.artifactId, title: currentFrame.dataset.artifactTitle, agentId: ctx.agentId || '' });
    });

    card.appendChild(header);
    card.appendChild(frame);
    host.appendChild(card);
    _checkArtifactAvailability(frame, ctx);
  }

  // One card per conversation/app identity. Revisions can arrive from live
  // callbacks, final messages or history replay; only newer ones reload it.
  function mountMessageArtifacts(bubbleEl, artifacts, cid) {
    if (!bubbleEl || !Array.isArray(artifacts) || !artifacts.length) return;
    for (const a of artifacts) {
      if (!a || !a.id) continue;
      const selector = `iframe.chat-artifact-frame[data-artifact-id="${CSS.escape(String(a.id))}"]`;
      const existing = bubbleEl.querySelector(selector)
        || Array.from(document.querySelectorAll(selector)).find(frame => frame.dataset.artifactCid === String(cid));
      if (existing && existing.dataset.artifactCid === String(cid)) {
        const revision = Number.isSafeInteger(a.revision) && a.revision > 0 ? a.revision : 0;
        if (revision > Number(existing.dataset.artifactRevision || 0)) {
          existing.dataset.artifactRevision = String(revision);
          existing.dataset.artifactTitle = a.title || _t('artifact.title', 'Interactive app');
          const label = existing.parentNode.querySelector('.chat-artifact-title');
          if (label) { label.textContent = existing.dataset.artifactTitle; label.title = existing.dataset.artifactTitle; }
          _doReload({ frame: existing, cid, artifactId: a.id });
        }
        continue;
      }
      const host = document.createElement('div');
      host.className = 'chat-artifact-host';
      bubbleEl.appendChild(host);
      renderChatArtifact(host, {
        cid: cid,
        artifactId: a.id,
        title: a.title || '',
        agentId: a.agent_id || '',
        revision: a.revision,
      });
    }
  }

  // The conversation info panel lists artifacts too (an artifact bundle lives
  // outside the workspace, so a file scan can never see it). It opens them
  // through this same frame rather than building a second viewer.
  window.openChatArtifactViewer = _openViewer;
  window.renderChatArtifact = renderChatArtifact;
  window.mountMessageArtifacts = mountMessageArtifacts;
  window.encodeArtifactResult = encodeArtifactResult;
})();
