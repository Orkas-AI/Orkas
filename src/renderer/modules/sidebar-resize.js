/**
 * Drag-to-resize for the left sidebar.
 *
 * Drives `--sidebar-width` on `<html>`; the CSS rule on `.sidebar` consumes it
 * and clamps with min-width / max-width as a second line of defense. Width
 * persists in localStorage so it survives reloads on this machine (machine-
 * local UI preference, not synced across devices — same shape as other layout
 * prefs like artifact-rail collapse state would be).
 *
 * Double-click on the handle resets to the default.
 */
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const STORAGE_KEY = 'orkas:sidebar-width';
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 480;
  const DEFAULT_WIDTH = 200;

  function clamp(n) {
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    if (n < MIN_WIDTH) return MIN_WIDTH;
    if (n > MAX_WIDTH) return MAX_WIDTH;
    return n;
  }

  function applyWidth(px) {
    document.documentElement.style.setProperty('--sidebar-width', px + 'px');
  }

  function loadSavedWidth() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? clamp(n) : null;
    } catch (_) { return null; }
  }

  function saveWidth(px) {
    try { localStorage.setItem(STORAGE_KEY, String(px)); } catch (_) { /* quota / private mode */ }
  }

  function init() {
    const saved = loadSavedWidth();
    if (saved != null) applyWidth(saved);

    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.querySelector('.sidebar');
    if (!handle || !sidebar) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const next = clamp(startWidth + dx);
      applyWidth(next);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-sidebar-resizing');
      handle.classList.remove('is-active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Read back from the CSS var so we persist exactly the clamped value
      // we just rendered (covers the case where the pointer moved past the
      // limits during the drag).
      const cur = sidebar.getBoundingClientRect().width;
      saveWidth(Math.round(cur));
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      document.body.classList.add('is-sidebar-resizing');
      handle.classList.add('is-active');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      applyWidth(DEFAULT_WIDTH);
      saveWidth(DEFAULT_WIDTH);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
