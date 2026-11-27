// Open-source edition only. The first run ID is used locally to reject repeat delivery.
(() => {
  const key = 'orkas-open-source-support-v1';
  const card = document.getElementById('home-open-source-support');
  const settings = document.getElementById('settings-open-source');
  if (!card || !settings) return;

  const events = new Set(['home:show', 'home:open', 'home:dismiss', 'settings:show', 'settings:open']);
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { /* optional state */ }
  const state = {
    firstRun: typeof saved?.firstRun === 'string' ? saved.firstRun : '',
    eligible: saved?.eligible === true,
    decision: ['opened', 'dismissed'].includes(saved?.decision) ? saved.decision : '',
    recorded: Array.isArray(saved?.recorded) ? Array.from(new Set(saved.recorded.filter(entry => events.has(entry)))) : [],
  };

  function save() {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) { /* continue for this session */ }
  }

  function record(surface, action) {
    const event = `${surface}:${action}`;
    if (state.recorded.includes(event)) return;
    state.recorded.push(event);
    save();
    window.orkas?.invoke('openSourceSupport.record', { surface, action }).catch(() => {});
  }

  const visible = new Set();
  const surfaces = new Map([[card, 'home'], [settings, 'settings']]);
  function recordVisible() {
    if (document.visibilityState !== 'visible') return;
    for (const element of visible) {
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      record(surfaces.get(element), 'show');
      visible.delete(element);
      observer.unobserve(element);
    }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) visible.add(entry.target);
      else visible.delete(entry.target);
    }
    recordVisible();
  }, { threshold: 0.5 });
  for (const element of surfaces.keys()) observer.observe(element);
  document.addEventListener('visibilitychange', recordVisible);

  function decide(surface, action) {
    record(surface, 'show');
    state.decision ||= action === 'dismiss' ? 'dismissed' : 'opened';
    state.firstRun = '';
    card.hidden = true;
    // Preserve the choice even if this action has already been counted.
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
