// Width preference and resize behavior for the task's side panels. They share one preference
// unless a panel names its own.
(function () {
  const SHARED_STORAGE_KEY = 'orkas.conversationInfo.width';
  const controllers = new Map();
  const preferences = new Map();

  function preferenceFor(storageKey) {
    if (preferences.has(storageKey)) return preferences.get(storageKey);
    const preference = { storageKey, width: null };
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= 320) preference.width = saved;
    } catch (_) { /* Storage may be unavailable. */ }
    preferences.set(storageKey, preference);
    return preference;
  }

  function save(preference) {
    try { localStorage.setItem(preference.storageKey, String(preference.width)); } catch (_) {}
  }

  function bind(panelId, handleId, onResize, options = {}) {
    if (controllers.has(panelId)) return controllers.get(panelId);
    const panel = document.getElementById(panelId);
    const handle = document.getElementById(handleId);
    if (!panel || !handle) return null;
    const preference = preferenceFor(options.storageKey || SHARED_STORAGE_KEY);
    const defaultWidth = options.defaultWidth || (() => window.innerWidth * 0.3);
    let resizing = false;
    function apply() {
      const container = panel.parentElement;
      if (!container) return;
      const available = container.getBoundingClientRect().width;
      if (available <= 0) return;
      const minimum = Math.min(400, available);
      const maximum = Math.max(minimum, available - Math.min(420, available * 0.5));
      const width = Math.round(Math.max(minimum, Math.min(preference.width ?? defaultWidth(available), maximum)));
      if (preference.width !== null) preference.width = width;
      panel.style.width = `${width}px`;
      panel.style.flexBasis = `${width}px`;
      handle.setAttribute('aria-valuemin', String(Math.round(minimum)));
      handle.setAttribute('aria-valuemax', String(Math.round(maximum)));
      handle.setAttribute('aria-valuenow', String(width));
    }
    function finish() {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove('is-task-side-panel-resizing');
      onResize?.(false);
      save(preference);
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      preference.width = panel.getBoundingClientRect().width;
      resizing = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('is-task-side-panel-resizing');
      onResize?.(true);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!resizing) return;
      preference.width = panel.parentElement.getBoundingClientRect().right - event.clientX;
      apply();
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      preference.width = panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24);
      apply();
      save(preference);
    });
    const controller = { apply, finish };
    controllers.set(panelId, controller);
    apply();
    return controller;
  }

  window.addEventListener('resize', () => {
    for (const controller of controllers.values()) controller.apply();
  });
  // Header metadata can wrap or change during title editing without a window resize.
  const header = document.getElementById('chat-header');
  if (header && typeof ResizeObserver === 'function') {
    const syncHeaderHeight = () => {
      const height = header.getBoundingClientRect().height;
      if (height > 0) header.closest('.chat-container')?.style.setProperty('--task-side-panel-header-height', `${height}px`);
    };
    new ResizeObserver(() => requestAnimationFrame(syncHeaderHeight)).observe(header);
    syncHeaderHeight();
  }
  window.TaskSidePanel = { bind };
}());
