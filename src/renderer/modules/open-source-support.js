// Open-source edition only. The first run ID is used locally to reject repeat delivery.
(() => {
  const key = 'orkas-open-source-support-v1';
  const card = document.getElementById('home-open-source-support');
  const settings = document.getElementById('settings-open-source');
  if (!card || !settings) return;

  let saved;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { /* optional state */ }
  const state = {
    firstRun: typeof saved?.firstRun === 'string' ? saved.firstRun : '',
    eligible: saved?.eligible === true,
    decision: ['opened', 'dismissed'].includes(saved?.decision) ? saved.decision : '',
  };

  function save() {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) { /* continue for this session */ }
  }

  function record(surface, action) {
    window.orkas?.invoke('openSourceSupport.record', { surface, action }).catch(() => {});
  }

  const surfaces = new Map([
    [card, { name: 'home', inView: false, wasVisible: false }],
    [settings, { name: 'settings', inView: false, wasVisible: false }],
  ]);
  function updateExposures(entries = []) {
    for (const entry of entries) {
      surfaces.get(entry.target).inView = entry.isIntersecting && entry.intersectionRatio >= 0.5;
    }
    for (const [element, exposure] of surfaces) {
      const visible = document.visibilityState === 'visible' && exposure.inView
        && element.checkVisibility({ visibilityProperty: true });
      if (visible && !exposure.wasVisible) record(exposure.name, 'show');
      exposure.wasVisible = visible;
    }
  }
  const observer = new IntersectionObserver(updateExposures, { threshold: 0.5 });
  for (const element of surfaces.keys()) observer.observe(element);
  document.addEventListener('visibilitychange', () => updateExposures(observer.takeRecords()));

  function decide(surface, action) {
    updateExposures(observer.takeRecords());
    state.decision ||= action === 'dismiss' ? 'dismissed' : 'opened';
    state.firstRun = '';
    card.hidden = true;
    save();
    record(surface, action);
  }
  card.querySelector('a').addEventListener('click', () => decide('home', 'open'));
  card.querySelector('button').addEventListener('click', event => {
    decide('home', 'dismiss');
    if (event.detail === 0) document.getElementById('new-chat-btn')?.focus({ preventScroll: true });
  });
  settings.querySelector('a').addEventListener('click', () => decide('settings', 'open'));

  window.orkas?.onPushEvent('conversation:task_terminal', payload => {
    if (state.eligible || state.decision || payload?.type !== 'terminal'
        || payload.status !== 'completed' || payload.kind !== 'task') return;
    const run = payload.run_id;
    if (typeof run !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(run) || run === state.firstRun) return;
    state.eligible = Boolean(state.firstRun);
    state.firstRun = state.eligible ? '' : run;
    save();
  });

  window.OpenSourceSupport = {
    onHomeEnter() { card.hidden = !state.eligible || Boolean(state.decision); },
  };
})();
