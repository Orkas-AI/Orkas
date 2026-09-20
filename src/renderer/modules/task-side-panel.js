// Shared width preference and resize behavior for the task's side panels.
(function () {
  const storageKey = 'orkas.conversationInfo.width';
  const controllers = new Map();
  let preferredWidth = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 320) preferredWidth = saved;
  } catch (_) { /* Storage may be unavailable. */ }

  function save() {
    try { localStorage.setItem(storageKey, String(preferredWidth)); } catch (_) {}
  }

  function bind(panelId, handleId, onResize) {
    if (controllers.has(panelId)) return controllers.get(panelId);
    const panel = document.getElementById(panelId);
    const handle = document.getElementById(handleId);
    if (!panel || !handle) return null;
    let resizing = false;
    function apply() {
      const container = panel.parentElement;
      if (!container) return;
      const available = container.getBoundingClientRect().width;
      if (available <= 0) return;
      const minimum = Math.min(400, available);
      const maximum = Math.max(minimum, available - Math.min(420, available * 0.5));
      const width = Math.round(Math.max(minimum, Math.min(preferredWidth ?? window.innerWidth * 0.3, maximum)));
      if (preferredWidth !== null) preferredWidth = width;
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
      save();
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      preferredWidth = panel.getBoundingClientRect().width;
      resizing = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('is-task-side-panel-resizing');
      onResize?.(true);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!resizing) return;
      preferredWidth = panel.parentElement.getBoundingClientRect().right - event.clientX;
      apply();
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      preferredWidth = panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 24 : -24);
      apply();
      save();
    });
    const controller = { apply, finish };
    controllers.set(panelId, controller);
    apply();
    return controller;
  }

  window.addEventListener('resize', () => {
    for (const controller of controllers.values()) controller.apply();
  });
  window.TaskSidePanel = { bind };
}());
