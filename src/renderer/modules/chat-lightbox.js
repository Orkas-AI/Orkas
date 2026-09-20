// ─── Chat image lightbox ──────────────────────────────────────────────
// Lazy-create a single fullscreen overlay on first call — cheaper than
// baking it into index.html and keeps this module self-contained.
//
// Interactions:
//   - × button / Esc                         → close
//   - Left / Right arrows / side buttons      → previous / next chat image
//   - + / =                                   → zoom in (around image center)
//   - - / _                                   → zoom out
//   - 0                                       → reset to 1× and re-center
//   - Double-click image                      → toggle 1× / 2×
//   - Drag image (when zoomed)                → pan
//
// Usage:  openChatImageLightbox(src, alt?)
//   src   `chat-media://…` URL (or any <img>-loadable src)
//   alt   plain string (already-safe) used for accessibility
//
// Document-level click delegation also fires this lightbox for any
// `img.chat-md-img` (markdown-rendered images in chat bubbles), so
// every renderer module that emits a chat-md-img gets clickability for
// free without needing per-call wiring.

let _lightboxEl = null;
let _lightboxImg = null;
let _lightboxAddLibraryBtn = null;
let _lightboxRevealBtn = null;
let _lightboxKeyHandler = null;
let _lightboxCurrentFile = null;
let _lightboxLoadSeq = 0;
let _lightboxLoadCleanup = null;
let _lightboxGallery = null;
let _lightboxPreviousFocus = null;

// Zoom / pan state. Reset on every close so the next open starts at 1×.
let _scale = 1;
let _tx = 0;
let _ty = 0;
let _isPanning = false;
let _panStart = null;

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;
const _LIGHTBOX_LIBRARY_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function _lightboxExtOf(name) {
  if (!name) return '';
  const i = String(name).lastIndexOf('.');
  return i >= 0 ? String(name).slice(i).toLowerCase() : '';
}

function _lightboxCanAddToLibrary(file) {
  return !!(file && file.absPath && file.cid && _LIGHTBOX_LIBRARY_IMAGE_EXTS.has(_lightboxExtOf(file.absPath)));
}

function _absPathFromChatMediaLocalUrl(src) {
  if (!src) return '';
  let url;
  try { url = new URL(String(src)); }
  catch (_) { return ''; }
  if (url.protocol !== 'chat-media:' || url.hostname !== 'local') return '';
  let p;
  try { p = decodeURIComponent(url.pathname || ''); }
  catch (_) { return ''; }
  if (!p) return '';
  if (/^\/[A-Za-z]:\//.test(p)) return p.slice(1);
  if (/^\/\/[^/]/.test(p)) p = p.replace(/^\/+/, '/');
  return p.startsWith('/') ? p : `/${p}`;
}

function _isOpen() {
  return !!(_lightboxEl && _lightboxEl.classList.contains('is-open'));
}

function _applyTransform() {
  if (!_lightboxImg) return;
  _lightboxImg.style.transform = `translate(${_tx}px, ${_ty}px) scale(${_scale})`;
  _lightboxImg.style.cursor = _scale > 1 ? (_isPanning ? 'grabbing' : 'grab') : 'zoom-in';
}

function _resetZoom() {
  _scale = 1;
  _tx = 0;
  _ty = 0;
  _applyTransform();
}

function _lightboxLoadingLabel() {
  try {
    const label = t('common.loading');
    return label && label !== 'common.loading' ? label : 'Loading…';
  } catch (_) {
    return 'Loading…';
  }
}

function _lightboxEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _setLightboxLoading(loading) {
  if (!_lightboxEl) return;
  _lightboxEl.classList.toggle('is-loading', !!loading);
  const stage = _lightboxEl.querySelector('.chat-lightbox-stage');
  const status = _lightboxEl.querySelector('.chat-lightbox-loading');
  if (stage) {
    if (loading) stage.setAttribute('aria-busy', 'true');
    else stage.removeAttribute('aria-busy');
  }
  if (status) status.hidden = !loading;
}

function _clearLightboxLoadListeners() {
  if (!_lightboxLoadCleanup) return;
  _lightboxLoadCleanup();
  _lightboxLoadCleanup = null;
}

// Cursor-anchored zoom: keep the image-pixel currently under (fx, fy)
// at the same screen position after the scale change. Falls back to
// center-anchor when no cursor coords are supplied (keyboard zoom).
//
// Math: let visible_c be the image's current on-screen center (which
// equals the pre-transform center plus the running translate). The
// translate delta needed to keep the cursor anchored is
//   Δt = (cursor - visible_c) · (1 − s'/s)
// — derived by requiring that the image-relative coord under the cursor
// be invariant across the scale change.
function _setScale(newScale, fx, fy) {
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  if (clamped === _scale) return;
  if (_lightboxImg && fx != null && fy != null) {
    const rect = _lightboxImg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ratio = clamped / _scale;
    _tx += (fx - cx) * (1 - ratio);
    _ty += (fy - cy) * (1 - ratio);
  }
  _scale = clamped;
  _applyTransform();
}

function _onWheel(e) {
  if (!_isOpen()) return;
  // Wheel-based zoom is intentionally disabled on the lightbox:
  //   - trackpad pinch (ctrlKey wheel) reports the two-finger centroid
  //     as clientX/Y, which jitters → cursor-anchored zoom drifts
  //   - trackpad two-finger swipe (plain wheel) zooms in/out way too
  //     fast for a seated reader and also feels drifty
  //   - real mouse wheel works fine, but few users mix mouse + lightbox
  //     vs. trackpad on this app's typical hardware (laptops)
  // Users still have +/-/0 keyboard shortcuts and double-click toggle.
  // We still preventDefault so the chat behind doesn't scroll while
  // the lightbox is open and so trackpad pinch doesn't trigger the
  // browser's own page zoom.
  e.preventDefault();
}

function _onDblClick(e) {
  if (!_isOpen()) return;
  if (e.target !== _lightboxImg) return;
  e.preventDefault();
  if (_scale > 1.001) _resetZoom();
  else _setScale(2, e.clientX, e.clientY);
}

function _onMouseDown(e) {
  if (!_isOpen()) return;
  if (e.target !== _lightboxImg) return;
  if (e.button !== 0) return;             // left button only
  if (_scale <= 1.001) return;            // no-op when fitted (avoid stealing drag-to-save)
  _isPanning = true;
  _panStart = { x: e.clientX - _tx, y: e.clientY - _ty };
  // Kill the smooth-zoom transition during a pan; otherwise every
  // mousemove queues a fresh 120ms ease that the next move interrupts,
  // which looks like the image lagging behind the cursor.
  if (_lightboxImg) {
    _lightboxImg.style.transition = 'none';
    _lightboxImg.style.cursor = 'grabbing';
  }
  e.preventDefault();
}

function _onMouseMove(e) {
  if (!_isPanning) return;
  _tx = e.clientX - _panStart.x;
  _ty = e.clientY - _panStart.y;
  _applyTransform();
}

function _onMouseUp() {
  if (!_isPanning) return;
  _isPanning = false;
  // Restore the transition so subsequent wheel / keyboard zooms ease in.
  if (_lightboxImg) _lightboxImg.style.transition = '';
  _applyTransform();
}

// Keep the gallery scoped to the source transcript, including offscreen messages.
// Recollect after history pagination or streaming replaces message DOM nodes.
function _lightboxGalleryItems(gallery) {
  if (gallery.items) return gallery.items;
  const occurrences = new Map();
  return Array.from(gallery.root.querySelectorAll('img.chat-md-img, .chat-msg-attach')).flatMap((node) => {
    const attachment = node.classList.contains('chat-msg-attach');
    const img = attachment ? node.querySelector('img.chat-attach-thumb') : node;
    const src = img && img.getAttribute('src');
    if (!src) return [];
    const message = node.closest?.('.chat-message');
    const identity = message?.dataset.renderKey || message?.dataset.msgId || '';
    const base = `${identity}:${src}`;
    const occurrence = occurrences.get(base) || 0;
    occurrences.set(base, occurrence + 1);
    return [{
      node, src, key: `${base}:${occurrence}`, absPath: _absPathFromChatMediaLocalUrl(src) || undefined,
      alt: attachment ? node.dataset.attachName || '' : (img.alt || ''),
      cid: attachment ? node.dataset.attachCid || gallery.cid : gallery.cid,
      attachmentName: attachment ? node.dataset.attachName : null,
    }];
  });
}

function _lightboxGalleryIndex(gallery, items) {
  if (gallery.items) return items.findIndex(item => item.key === gallery.selectedKey);
  const exact = items.findIndex((item) => item.node === gallery.source);
  if (exact >= 0) return exact;
  return items.findIndex((item) => item.src === gallery.src);
}

function _lightboxEarlierRow(gallery) {
  if (gallery.items) return gallery.nextCursor != null ? { dataset: { cursor: String(gallery.nextCursor) } } : null;
  if (gallery.root.id !== 'chat-history' || typeof _loadOlderConversationHistory !== 'function') return null;
  return gallery.root.querySelector('.chat-history-load-earlier');
}

function _updateLightboxNavigation() {
  if (!_lightboxEl) return;
  const gallery = _lightboxGallery;
  const items = gallery ? _lightboxGalleryItems(gallery) : [];
  const index = gallery ? _lightboxGalleryIndex(gallery, items) : -1;
  const earlier = gallery && _lightboxEarlierRow(gallery);
  const visible = index >= 0 && (items.length > 1 || !!earlier);
  for (const [direction, key] of [['previous', 'chat.lightbox_previous'], ['next', 'chat.lightbox_next']]) {
    const button = _lightboxEl.querySelector(`.chat-lightbox-${direction}`);
    button.hidden = !visible;
    button.disabled = !visible || !!gallery?.busy || (direction === 'previous'
      ? index === 0 && !earlier : index === items.length - 1);
    button.setAttribute('aria-label', t(key));
    button.title = t(key);
  }
}

function _disposeLightboxGallery() {
  _lightboxGallery?.observer?.disconnect();
  _lightboxGallery = null;
}

function _createLightboxGallery(source, src, opts) {
  if (opts?.gallery?.items) return opts.gallery;
  const root = source?.closest('.chat-history');
  if (!root) return null;
  const cid = opts?.cid || (typeof currentCid !== 'undefined' ? currentCid : null);
  const gallery = { root, cid, source, src, busy: false };
  const items = _lightboxGalleryItems(gallery);
  // Produced-file chips open the same image already expanded in their bubble.
  if (_lightboxGalleryIndex(gallery, items) < 0 && opts?.absPath) {
    const item = items.find((entry) => _absPathFromChatMediaLocalUrl(entry.src) === opts.absPath);
    if (item) { gallery.source = item.node; gallery.src = item.src; }
  }
  gallery.observer = new MutationObserver(() => {
    if (typeof currentCid !== 'undefined' && gallery.root.id === 'chat-history' && currentCid !== gallery.cid) {
      closeChatImageLightbox();
      return;
    }
    _updateLightboxNavigation();
  });
  gallery.observer.observe(root, { childList: true, subtree: true });
  return gallery;
}

async function _navigateLightbox(direction) {
  const gallery = _lightboxGallery;
  if (!gallery || gallery.busy || !_isOpen()) return;
  const active = () => _lightboxGallery === gallery && _isOpen() && (gallery.items || (gallery.root.isConnected
    && (gallery.root.id !== 'chat-history' || typeof currentCid === 'undefined' || currentCid === gallery.cid)));
  if (!active()) return;
  gallery.busy = true;
  _updateLightboxNavigation();
  try {
    let items = _lightboxGalleryItems(gallery);
    let index = _lightboxGalleryIndex(gallery, items);
    // Walk text-only older pages too, using the transcript owner's existing
    // loader so visibility rules, ordering, and reading position stay intact.
    while (direction < 0 && index === 0 && _lightboxEarlierRow(gallery)) {
      const row = _lightboxEarlierRow(gallery);
      const cursor = row.dataset.cursor;
      _setLightboxLoading(true);
      if (gallery.items) await window.OrkasPreviewHost.loadGalleryPage(gallery, Number(cursor));
      else await _loadOlderConversationHistory(gallery.cid, Number(cursor));
      if (!active()) return;
      const nextRow = _lightboxEarlierRow(gallery);
      if (nextRow && nextRow.dataset.cursor === cursor) {
        if (typeof uiToast === 'function') uiToast(t('chat.lightbox_history_failed'), { variant: 'warning' });
        return;
      }
      items = _lightboxGalleryItems(gallery);
      index = _lightboxGalleryIndex(gallery, items);
    }
    const item = index >= 0 ? items[index + direction] : null;
    if (!item) return;
    let fileOpts = { cid: item.cid, absPath: item.absPath };
    if (item.attachmentName) {
      _setLightboxLoading(true);
      try {
        const result = await window.orkas.invoke('attachments.absPath', { cid: item.cid, name: item.attachmentName });
        if (result?.ok && result.path) fileOpts.absPath = result.path;
      } catch (_) { /* The image URL still supplies a preview or its native error state. */ }
      if (!active()) return;
    }
    gallery.source = item.node;
    gallery.src = item.src;
    gallery.selectedKey = item.key;
    openChatImageLightbox(item.src, item.alt, { ...fileOpts, gallery });
  } finally {
    gallery.busy = false;
    if (active()) {
      if (gallery.src === _lightboxImg.getAttribute('src') && !_lightboxLoadCleanup) _setLightboxLoading(false);
      _updateLightboxNavigation();
    }
  }
}

function _ensureLightbox() {
  if (_lightboxEl) return _lightboxEl;
  const root = document.createElement('div');
  root.className = 'chat-lightbox';
  root.setAttribute('aria-hidden', 'true');
  const closeLabel = t('chat.lightbox_close_title');
  const addLabel = t('chat.preview_add_library_title');
  const revealLabel = t('chat.preview_reveal_title');
  const libraryIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('database', 'chat-lightbox-library-icon')
    : '';
  const folderIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('folder', 'chat-lightbox-folder-icon')
    : '';
  const closeIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('x', 'modal-close-icon')
    : '×';
  root.innerHTML = `
    <div class="chat-lightbox-backdrop"></div>
    <div class="chat-lightbox-stage">
      <div class="chat-lightbox-title"></div>
      <button type="button" class="chat-lightbox-nav chat-lightbox-previous" hidden>${typeof window.uiIconHtml === 'function' ? window.uiIconHtml('chevron-left', 'ui-icon') : ''}</button>
      <button type="button" class="chat-lightbox-nav chat-lightbox-next" hidden>${typeof window.uiIconHtml === 'function' ? window.uiIconHtml('chevron-right', 'ui-icon') : ''}</button>
      <div class="chat-lightbox-loading" role="status" aria-live="polite" hidden>
        <span class="chat-file-viewer-loading-spinner" aria-hidden="true"></span>
        <span class="chat-lightbox-loading-label">${_lightboxEscapeHtml(_lightboxLoadingLabel())}</span>
      </div>
      <img class="chat-lightbox-img" alt="" draggable="false" data-monitor-resource="chat-image-lightbox" />
      <div class="chat-lightbox-actions">
        <button type="button" class="chat-lightbox-add-library" aria-label="${addLabel}" title="${addLabel}" hidden>
          ${libraryIcon}
        </button>
        <button type="button" class="chat-lightbox-reveal" aria-label="${revealLabel}" title="${revealLabel}" hidden>
          ${folderIcon}
        </button>
        <button type="button" class="modal-close-btn chat-lightbox-close" aria-label="${closeLabel}" title="${closeLabel}">${closeIcon}</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  // Lightbox is a one-shot DOM chunk — we lazy-create it on first open, so
  // an `i18n-change` listener here will re-label on every subsequent
  // language switch without leaking listeners.
  window.addEventListener('i18n-change', () => {
    if (!_lightboxEl) return;
    const btn = _lightboxEl.querySelector('.chat-lightbox-close');
    if (btn) {
      const label = t('chat.lightbox_close_title');
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
    const add = _lightboxEl.querySelector('.chat-lightbox-add-library');
    if (add) {
      const label = t('chat.preview_add_library_title');
      add.setAttribute('aria-label', label);
      add.setAttribute('title', label);
    }
    const reveal = _lightboxEl.querySelector('.chat-lightbox-reveal');
    if (reveal) {
      const label = t('chat.preview_reveal_title');
      reveal.setAttribute('aria-label', label);
      reveal.setAttribute('title', label);
    }
    const loading = _lightboxEl.querySelector('.chat-lightbox-loading-label');
    if (loading) loading.textContent = _lightboxLoadingLabel();
    _updateLightboxNavigation();
  });
  _lightboxEl = root;
  _lightboxImg = root.querySelector('.chat-lightbox-img');
  _lightboxAddLibraryBtn = root.querySelector('.chat-lightbox-add-library');
  _lightboxRevealBtn = root.querySelector('.chat-lightbox-reveal');

  // × closes; backdrop clicks are ignored to avoid accidental dismissals.
  root.querySelector('.chat-lightbox-close').addEventListener('click', closeChatImageLightbox);
  _lightboxAddLibraryBtn.addEventListener('click', _onLightboxAddLibrary);
  _lightboxRevealBtn.addEventListener('click', _onLightboxReveal);

  // Zoom + pan. wheel must be non-passive to allow preventDefault (modern
  // Chromium defaults wheel listeners on document/window to passive).
  root.addEventListener('wheel', _onWheel, { passive: false });
  _lightboxImg.addEventListener('dblclick', _onDblClick);
  _lightboxImg.addEventListener('mousedown', _onMouseDown);
  // Mouse-move / up live on the document so a pan that drags out past
  // the image still updates and ends cleanly.
  document.addEventListener('mousemove', _onMouseMove);
  document.addEventListener('mouseup', _onMouseUp);

  return root;
}

async function _onLightboxReveal(e) {
  e.stopPropagation();
  if (!_lightboxCurrentFile || !_lightboxRevealBtn || _lightboxRevealBtn.disabled) return;
  const file = _lightboxCurrentFile;
  const sequence = _lightboxLoadSeq;
  _lightboxRevealBtn.disabled = true;
  try {
    const payload = { path: file.absPath };
    if (file.cid) payload.cid = file.cid;
    if (file.projectId) payload.projectId = file.projectId;
    const res = await window.orkas.invoke('workspace.revealPath', payload);
    if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
  } catch (err) {
    try {
      const reason = String(err && err.message || err);
      const message = t('conversation_info.file_reveal_failed', { reason });
      if (typeof uiAlert === 'function') await uiAlert(message && message !== 'conversation_info.file_reveal_failed' ? message : reason);
    } catch (_) { /* best-effort; reveal failures are already non-destructive */ }
  } finally {
    if (_lightboxRevealBtn && sequence === _lightboxLoadSeq) _lightboxRevealBtn.disabled = false;
  }
}

async function _onLightboxAddLibrary(e) {
  e.stopPropagation();
  if (!_lightboxCurrentFile || !_lightboxAddLibraryBtn || _lightboxAddLibraryBtn.disabled) return;
  const file = _lightboxCurrentFile;
  if (!_lightboxCanAddToLibrary(file)) return;
  const original = _lightboxAddLibraryBtn.innerHTML;
  const sequence = _lightboxLoadSeq;
  _lightboxAddLibraryBtn.disabled = true;
  try {
    const payload = { path: file.absPath };
    if (file.cid) payload.cid = file.cid;
    if (file.projectId) payload.projectId = file.projectId;
    const res = await window.orkas.invoke('library.importProduced', payload);
    if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
    const checkIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
      ? window.uiIconHtml('check', 'chat-lightbox-library-icon')
      : '';
    window.OrkasPreviewHost?.filesChanged();
    if (sequence === _lightboxLoadSeq) _lightboxAddLibraryBtn.innerHTML = checkIcon;
    if (res.scope === 'global' && typeof currentView !== 'undefined' && currentView === 'contexts' && typeof loadContexts === 'function') loadContexts();
    if (res.scope === 'project' && res.projectId && typeof currentView !== 'undefined' && currentView === 'project' && typeof loadProjectDetail === 'function') {
      loadProjectDetail(res.projectId).catch(() => {});
    }
  } catch (err) {
    let message = `Add to Library failed: ${String(err && err.message || err)}`;
    try {
      const got = t('chat.preview_add_library_failed_with', { reason: String(err && err.message || err) });
      if (got && got !== 'chat.preview_add_library_failed_with') message = got;
    } catch (_) { /* keep fallback */ }
    if (typeof uiAlert === 'function') await uiAlert(message);
  } finally {
    setTimeout(() => {
      if (!_lightboxAddLibraryBtn || sequence !== _lightboxLoadSeq) return;
      _lightboxAddLibraryBtn.innerHTML = original;
      _lightboxAddLibraryBtn.disabled = false;
    }, 1500);
  }
}

function openChatImageLightbox(src, alt, opts) {
  if (!src) return;
  if (window.OrkasPreviewWindows) return window.OrkasPreviewWindows.image(src, alt, opts);
  const wasOpen = _isOpen();
  if (!wasOpen) _lightboxPreviousFocus = document.activeElement;
  const el = _ensureLightbox();
  if (!opts?.gallery || opts.gallery !== _lightboxGallery) {
    _disposeLightboxGallery();
    _lightboxGallery = _createLightboxGallery(opts?.sourceElement, src, opts);
  }
  _isPanning = false;
  _panStart = null;
  _lightboxImg.style.transition = '';
  _lightboxAddLibraryBtn.disabled = false;
  _lightboxAddLibraryBtn.innerHTML = typeof window.uiIconHtml === 'function' ? window.uiIconHtml('database', 'chat-lightbox-library-icon') : '';
  _lightboxRevealBtn.disabled = false;
  _lightboxLoadSeq += 1;
  const loadSeq = _lightboxLoadSeq;
  _clearLightboxLoadListeners();
  _resetZoom();
  _lightboxImg.alt = alt || '';
  const title = el.querySelector('.chat-lightbox-title');
  if (title) title.textContent = alt || '';
  if (window.OrkasPreviewHost) document.title = alt || 'Orkas';
  _setLightboxLoading(true);
  const settle = () => {
    if (loadSeq !== _lightboxLoadSeq) return;
    _clearLightboxLoadListeners();
    _setLightboxLoading(false);
  };
  _lightboxImg.addEventListener('load', settle, { once: true });
  _lightboxImg.addEventListener('error', settle, { once: true });
  _lightboxLoadCleanup = () => {
    _lightboxImg.removeEventListener('load', settle);
    _lightboxImg.removeEventListener('error', settle);
  };
  _lightboxImg.src = src;
  const inferredAbsPath = (!opts || !opts.absPath) ? _absPathFromChatMediaLocalUrl(src) : '';
  const fallbackCid = (typeof currentCid !== 'undefined' && currentCid) ? currentCid : null;
  const fileOpts = (opts && opts.absPath)
    ? opts
    : (inferredAbsPath ? { absPath: inferredAbsPath, cid: opts?.cid || fallbackCid } : null);
  _lightboxCurrentFile = fileOpts && fileOpts.absPath ? {
    absPath: fileOpts.absPath,
    cid: fileOpts.cid || null,
    projectId: fileOpts.projectId || null,
  } : null;
  if (_lightboxAddLibraryBtn) _lightboxAddLibraryBtn.hidden = !_lightboxCanAddToLibrary(_lightboxCurrentFile);
  if (_lightboxRevealBtn) _lightboxRevealBtn.hidden = !_lightboxCurrentFile;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  if (!wasOpen) el.querySelector('.chat-lightbox-close').focus({ preventScroll: true });
  _updateLightboxNavigation();
  if (!_lightboxKeyHandler) {
    _lightboxKeyHandler = (e) => {
      if (!_isOpen() || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
        e.preventDefault();
        e.stopPropagation();
        void _navigateLightbox(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'Escape') {
        closeChatImageLightbox();
      } else if (e.key === '+' || e.key === '=') {
        _setScale(_scale * ZOOM_STEP);
        e.preventDefault();
      } else if (e.key === '-' || e.key === '_') {
        _setScale(_scale / ZOOM_STEP);
        e.preventDefault();
      } else if (e.key === '0') {
        _resetZoom();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', _lightboxKeyHandler);
  }
}

function _releaseLightboxImage(image) {
  if (!image) return;
  // `image.src = ''` resolves to the current document URL in Chromium and
  // emits a false resource-load failure. Removing the attribute releases the
  // protocol/blob handle without starting another image request.
  image.removeAttribute('src');
}

function closeChatImageLightbox() {
  if (!_lightboxEl) return;
  _lightboxLoadSeq += 1;
  _clearLightboxLoadListeners();
  _setLightboxLoading(false);
  _lightboxEl.classList.remove('is-open');
  _lightboxEl.setAttribute('aria-hidden', 'true');
  // Drop the <img> src so the browser can release the blob / protocol
  // handle — keeps memory tidy if user opens many large images.
  if (_lightboxImg) {
    _releaseLightboxImage(_lightboxImg);
    // Defensively restore the transition in case close fires during an
    // active pan (mouseup never came). Otherwise the next open would
    // start with transition:none stuck on the element.
    _lightboxImg.style.transition = '';
  }
  _lightboxCurrentFile = null;
  _disposeLightboxGallery();
  if (_lightboxPreviousFocus?.isConnected) _lightboxPreviousFocus.focus({ preventScroll: true });
  _lightboxPreviousFocus = null;
  if (_lightboxAddLibraryBtn) _lightboxAddLibraryBtn.hidden = true;
  if (_lightboxRevealBtn) _lightboxRevealBtn.hidden = true;
  _isPanning = false;
  _resetZoom();
  if (_lightboxKeyHandler) {
    document.removeEventListener('keydown', _lightboxKeyHandler);
    _lightboxKeyHandler = null;
  }
  window.OrkasPreviewHost?.close();
}

// Document-level delegation: any markdown-rendered chat image
// (`img.chat-md-img`, emitted by utils.js::inlineFormat) is clickable
// without per-call wiring. We capture-phase-listen so the click is
// caught even if a parent handler stops bubbling later.
//
// Skips srcless / data:placeholder images so streaming-half-rendered
// markdown doesn't pop empty lightboxes.
document.addEventListener('click', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  if (!img.classList || !img.classList.contains('chat-md-img')) return;
  if (!img.src) return;
  e.preventDefault();
  openChatImageLightbox(img.src, img.alt || '', { sourceElement: img });
});
