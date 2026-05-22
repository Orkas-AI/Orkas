// ─── Chat image lightbox ──────────────────────────────────────────────
// Lazy-create a single fullscreen overlay on first call — cheaper than
// baking it into index.html and keeps this module self-contained.
//
// Interactions:
//   - Click backdrop / × button / Esc        → close
//   - Wheel                                   → zoom (cursor-anchored)
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
let _lightboxKeyHandler = null;

// Zoom / pan state. Reset on every close so the next open starts at 1×.
let _scale = 1;
let _tx = 0;
let _ty = 0;
let _isPanning = false;
let _panStart = null;

const MIN_SCALE = 0.5;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;

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

function _ensureLightbox() {
  if (_lightboxEl) return _lightboxEl;
  const root = document.createElement('div');
  root.className = 'chat-lightbox';
  root.setAttribute('aria-hidden', 'true');
  const closeLabel = t('chat.lightbox_close_title');
  root.innerHTML = `
    <div class="chat-lightbox-backdrop"></div>
    <div class="chat-lightbox-stage">
      <img class="chat-lightbox-img" alt="" draggable="false" />
      <button type="button" class="chat-lightbox-close" aria-label="${closeLabel}" title="${closeLabel}">×</button>
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
  });
  _lightboxEl = root;
  _lightboxImg = root.querySelector('.chat-lightbox-img');

  // Backdrop + × close; clicking the image itself does NOT close so user
  // can drag-to-pan or right-click save without accidentally dismissing.
  root.querySelector('.chat-lightbox-backdrop').addEventListener('click', closeChatImageLightbox);
  root.querySelector('.chat-lightbox-close').addEventListener('click', closeChatImageLightbox);

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

function openChatImageLightbox(src, alt) {
  if (!src) return;
  const el = _ensureLightbox();
  _resetZoom();
  _lightboxImg.src = src;
  _lightboxImg.alt = alt || '';
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  if (!_lightboxKeyHandler) {
    _lightboxKeyHandler = (e) => {
      if (!_isOpen()) return;
      if (e.key === 'Escape') {
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

function closeChatImageLightbox() {
  if (!_lightboxEl) return;
  _lightboxEl.classList.remove('is-open');
  _lightboxEl.setAttribute('aria-hidden', 'true');
  // Drop the <img> src so the browser can release the blob / protocol
  // handle — keeps memory tidy if user opens many large images.
  if (_lightboxImg) {
    _lightboxImg.src = '';
    // Defensively restore the transition in case close fires during an
    // active pan (mouseup never came). Otherwise the next open would
    // start with transition:none stuck on the element.
    _lightboxImg.style.transition = '';
  }
  _isPanning = false;
  _resetZoom();
  if (_lightboxKeyHandler) {
    document.removeEventListener('keydown', _lightboxKeyHandler);
    _lightboxKeyHandler = null;
  }
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
  openChatImageLightbox(img.src, img.alt || '');
});
