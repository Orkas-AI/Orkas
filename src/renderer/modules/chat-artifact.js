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
// `event.source` is one of our live artifact iframes (the iframe is
// cross-origin — `chat-app://cid` ≠ `file://` — so origin-string checks are
// brittle; identity of the contentWindow is the robust check) and that
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
  const DEFAULT_FRAME_HEIGHT = 420;   // px, until the artifact reports its own
  const MAX_FRAME_HEIGHT = 640;       // px, clamp; the iframe scrolls past this
  const MIN_FRAME_HEIGHT = 80;        // px
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms';
  // `allow-same-origin` is safe: the artifact's origin (`chat-app://cid`) is
  // never the renderer's (`file://...`), so the same-origin policy already
  // blocks `parent.*` — the flag only lets the artifact keep a usable origin
  // for localStorage / same-origin sibling fetch. We deliberately omit
  // `allow-popups` / `allow-top-navigation`.

  function _t(key, fallback) {
    try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _notifyFail(prefix, err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg ? `${prefix}: ${msg}` : prefix);
      else _convLog.warn(prefix, msg);
    } catch (_) {}
  }

  // Card-header "⋯" popover state. One shared menu element appended to <body>,
  // positioned to whichever ⋯ button opened it (same pattern as the agents /
  // contexts row menus); the acting context is stashed per-open.
  let _menuEl = null;
  let _menuCtx = null;     // { frame, cid, artifactId, title } of the open menu
  let _menuAnchor = null;  // the ⋯ button that opened it

  function _track(action, data) {
    
  }

  function _trackError(action, data) {
    
  }
  let _viewerEl = null;
  let _viewerFrame = null;
  let _viewerTitle = null;
  let _viewerKeyHandler = null;

  // chat-app://cid/<encCid>/<encArtifactId>/index.html
  function _artifactUrl(cid, artifactId, rel) {
    const parts = ['chat-app://cid', encodeURIComponent(String(cid)), encodeURIComponent(String(artifactId))];
    if (rel) parts.push(String(rel).split('/').map(encodeURIComponent).join('/'));
    else parts.push('index.html');
    return parts.join('/');
  }

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
    window.addEventListener('message', (ev) => {
      const data = ev && ev.data;
      if (!data || typeof data !== 'object' || data.__orkasArtifact !== true) return;
      const frame = _findArtifactFrame(ev.source);
      if (!frame) return; // not one of ours (or a stale/removed iframe)
      const cid = frame.dataset.artifactCid || '';
      const artifactId = frame.dataset.artifactId || '';
      const agentId = frame.dataset.artifactAgent || '';
      const title = frame.dataset.artifactTitle || '';
      const type = String(data.type || '');
      if (type === 'resize') {
        if (frame.classList && frame.classList.contains('chat-artifact-viewer-frame')) return;
        frame.style.height = `${_clampHeight(data.height)}px`;
        return;
      }
      if (type === 'open-external') {
        const url = String(data.url || '').trim();
        if (/^https?:\/\//i.test(url)) { try { window.open(url, '_blank', 'noopener'); } catch (_) {} }
        return;
      }
      if (type === 'submit' || type === 'sendToChat') {
        // Only the currently-viewed conversation has live iframes in the DOM,
        // but guard anyway — a result for a non-current cid is a stale fire.
        if (!cid || cid !== currentCid) return;
        const text = encodeArtifactResult(artifactId, agentId, title, data.payload);
        try { sendInCurrentConversation(text); }
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
          <button type="button" class="chat-artifact-viewer-close" aria-label="${_esc(_t('common.close', 'Close'))}" title="${_esc(_t('common.close', 'Close'))}">×</button>
        </div>
        <iframe class="chat-artifact-viewer-frame chat-artifact-frame" sandbox="${SANDBOX}" referrerpolicy="no-referrer"></iframe>
      </div>`;
    document.body.appendChild(el);
    _viewerEl = el;
    _viewerFrame = el.querySelector('.chat-artifact-viewer-frame');
    _viewerTitle = el.querySelector('.chat-artifact-viewer-title');
    el.querySelector('.chat-artifact-viewer-close')?.addEventListener('click', _closeViewer);
    return el;
  }

  function _openViewer(ctx) {
    if (!ctx || !ctx.cid || !ctx.artifactId) return;
    const el = _ensureViewer();
    const title = ctx.title || _t('artifact.title', 'Interactive app');
    if (_viewerTitle) _viewerTitle.textContent = title;
    if (_viewerFrame) {
      _viewerFrame.dataset.artifactCid = String(ctx.cid);
      _viewerFrame.dataset.artifactId = String(ctx.artifactId);
      _viewerFrame.dataset.artifactAgent = String(ctx.agentId || '');
      _viewerFrame.dataset.artifactTitle = title;
      _viewerFrame.setAttribute('title', title);
      _viewerFrame.src = _artifactUrl(ctx.cid, ctx.artifactId);
    }
    el.classList.add('is-open');
    if (!_viewerKeyHandler) {
      _viewerKeyHandler = (e) => { if (e.key === 'Escape') _closeViewer(); };
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.style.display !== 'none') _closeMenu(); });
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
        _track('artifact_menu_action', { action, cid: String(ctx.cid || ''), artifact_id: String(ctx.artifactId || '') });
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

  function _openMenu(anchorBtn, ctx) {
    const el = _ensureMenuEl();
    if (el.style.display !== 'none' && _menuAnchor === anchorBtn) { _closeMenu(); return; }
    _closeMenu();
    _menuCtx = ctx;
    _menuAnchor = anchorBtn;
    anchorBtn.classList.add('is-menu-open');
    _renderMenuItems(el);
    _positionMenu(el, anchorBtn);
  }

  function _doReload(ctx) {
    const f = ctx && ctx.frame;
    if (!f || !f.isConnected) return;
    _track('artifact_reload', { cid: String(ctx.cid || ''), artifact_id: String(ctx.artifactId || '') });
    // Reset height to default; the artifact re-reports on load. Reassigning
    // `src` forces a fresh load (the protocol handler sends `Cache-Control:
    // private` and dev reload ignores cache; this just re-runs the app).
    f.style.height = `${DEFAULT_FRAME_HEIGHT}px`;
    f.src = _artifactUrl(ctx.cid, ctx.artifactId);
  }

  function _doOpen(ctx) {
    _track('artifact_open_viewer', { cid: String(ctx.cid || ''), artifact_id: String(ctx.artifactId || '') });
    try { _openViewer(ctx); }
    catch (err) { _trackError('artifact_open_viewer', { msg: String(err && err.message || err) }); _notifyFail(_t('artifact.open_failed', 'Could not open'), err); }
  }

  async function _doSave(ctx) {
    _track('artifact_save', { cid: String(ctx.cid || ''), artifact_id: String(ctx.artifactId || '') });
    try {
      const r = await window.orkas.invoke('conversations.artifacts.save', {
        cid: String(ctx.cid), artifactId: String(ctx.artifactId),
      });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'save failed');
      _track('artifact_save_ok', { cid: String(ctx.cid || ''), artifact_id: String(ctx.artifactId || '') });
      try {
        const message = _t('apps.saved_toast', 'Saved to My Apps');
        if (typeof uiToast === 'function') uiToast(message, { variant: 'success' });
        else if (typeof uiAlert === 'function') uiAlert(message);
      } catch (_) {}
      // Refresh the "My Apps" tab if its module is loaded.
      try { if (typeof loadSavedApps === 'function') loadSavedApps(true); } catch (_) {}
    } catch (err) { _trackError('artifact_save', { msg: String(err && err.message || err) }); _notifyFail(_t('apps.save_failed', 'Could not save the app'), err); }
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
    frame.style.height = `${DEFAULT_FRAME_HEIGHT}px`;
    frame.src = _artifactUrl(ctx.cid, ctx.artifactId);

    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _track('artifact_menu_open', { cid: String(ctx.cid || ''), artifact_id: String(ctx.artifactId || '') });
      _openMenu(moreBtn, { frame, cid: ctx.cid, artifactId: ctx.artifactId, title, agentId: ctx.agentId || '' });
    });

    card.appendChild(header);
    card.appendChild(frame);
    host.appendChild(card);
  }

  // Render every artifact on a message into the given bubble. Idempotent —
  // skips ids already mounted in this bubble (the finalize / append paths
  // can both touch the same bubble).
  function mountMessageArtifacts(bubbleEl, artifacts, cid) {
    if (!bubbleEl || !Array.isArray(artifacts) || !artifacts.length) return;
    for (const a of artifacts) {
      if (!a || !a.id) continue;
      if (bubbleEl.querySelector(`iframe.chat-artifact-frame[data-artifact-id="${CSS.escape(String(a.id))}"]`)) continue;
      const host = document.createElement('div');
      host.className = 'chat-artifact-host';
      bubbleEl.appendChild(host);
      renderChatArtifact(host, {
        cid: cid,
        artifactId: a.id,
        title: a.title || '',
        agentId: a.agent_id || '',
      });
    }
  }

  window.renderChatArtifact = renderChatArtifact;
  window.mountMessageArtifacts = mountMessageArtifacts;
  window.encodeArtifactResult = encodeArtifactResult;
})();
