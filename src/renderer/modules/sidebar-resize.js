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
  const DEFAULT_WIDTH = 280;
  const MIN_MAIN_WIDTH = 320;
  const KEYBOARD_STEP = 10;

  function clampPreference(n) {
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    if (n < MIN_WIDTH) return MIN_WIDTH;
    if (n > MAX_WIDTH) return MAX_WIDTH;
    return n;
  }

  function viewportMaxWidth() {
    const viewportWidth = Number(window.innerWidth);
    if (!Number.isFinite(viewportWidth)) return MAX_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth - MIN_MAIN_WIDTH));
  }

  function loadSavedWidth() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const n = Number(raw);
      return raw.trim() && Number.isFinite(n) ? clampPreference(n) : null;
    } catch (_) { return null; }
  }

  function saveWidth(px) {
    try { localStorage.setItem(STORAGE_KEY, String(px)); } catch (_) { /* quota / private mode */ }
  }

  function init() {
    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.querySelector('.sidebar');
    let preferredWidth = loadSavedWidth() ?? DEFAULT_WIDTH;

    function applyPreferredWidth() {
      const maxWidth = viewportMaxWidth();
      const width = Math.min(clampPreference(preferredWidth), maxWidth);
      document.documentElement.style.setProperty('--sidebar-width', width + 'px');
      if (handle) {
        handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
        handle.setAttribute('aria-valuemax', String(maxWidth));
        handle.setAttribute('aria-valuenow', String(Math.round(width)));
      }
      return width;
    }

    applyPreferredWidth();
    if (!handle || !sidebar) return;
    handle.tabIndex = 0;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      preferredWidth = clampPreference(startWidth + dx);
      applyPreferredWidth();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('is-sidebar-resizing');
      handle.classList.remove('is-active');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      // Read back from the CSS var so we persist exactly the clamped value
      // we just rendered (covers the case where the pointer moved past the
      // limits during the drag).
      preferredWidth = clampPreference(Math.round(sidebar.getBoundingClientRect().width));
      saveWidth(preferredWidth);
    }

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || dragging) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      preferredWidth = startWidth;
      document.body.classList.add('is-sidebar-resizing');
      handle.classList.add('is-active');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('blur', onUp);
    });

    handle.addEventListener('keydown', (e) => {
      const currentWidth = sidebar.getBoundingClientRect().width;
      let next = null;
      if (e.key === 'ArrowLeft') next = currentWidth - KEYBOARD_STEP;
      else if (e.key === 'ArrowRight') next = currentWidth + KEYBOARD_STEP;
      else if (e.key === 'Home') next = MIN_WIDTH;
      else if (e.key === 'End') next = viewportMaxWidth();
      if (next == null) return;
      e.preventDefault();
      preferredWidth = clampPreference(next);
      applyPreferredWidth();
      saveWidth(preferredWidth);
    });

    handle.addEventListener('dblclick', () => {
      preferredWidth = DEFAULT_WIDTH;
      applyPreferredWidth();
      saveWidth(DEFAULT_WIDTH);
    });

    window.addEventListener('resize', applyPreferredWidth);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
