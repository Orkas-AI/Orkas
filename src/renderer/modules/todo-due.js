/* Calendar-day attention, independent of unread replies. No due-date state is persisted. */
(() => {
  const log = createLogger('todo-due');
  let account = '', rows = [], scopes = new Set();
  let revision = 0, dirty = false, loading = null, debounce = null, midnight = null, bound = false;
  const owner = () => typeof currentUserId === 'string' ? currentUserId : '';
  const label = () => t('project.todo.due_attention');
  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
  function isDue(task) {
    return task.status !== 'done'
      && validDay(task.due_at) && task.due_at <= today();
  }
  function ensureAccount() {
    if (account === owner()) return;
    account = owner();
    rows = [];
    scopes.clear();
    ++revision;
  }
  function hasScope(pid) { ensureAccount(); return scopes.has(pid || ''); }
  function hasProjects() { ensureAccount(); return [...scopes].some(Boolean); }
  function decorate(dot, visible) {
    dot.hidden = !visible;
    dot.title = label();
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', label());
  }
  function dotData(task) {
    return { todoDueDate: task.due_at || '', todoDueStatus: task.status || 'todo',
      todoDueAccount: owner() };
  }
  function createDot(task) {
    const dot = document.createElement('span');
    dot.className = 'task-unread-dot todo-due-dot';
    Object.assign(dot.dataset, dotData(task));
    decorate(dot, isDue(task));
    return dot;
  }
  function dotHtml(task) {
    const data = dotData(task);
    return `<span class="task-unread-dot todo-due-dot" data-todo-due-date="${escapeHtml(data.todoDueDate)}"`
      + ` data-todo-due-status="${escapeHtml(data.todoDueStatus)}"`
      + ` data-todo-due-account="${escapeHtml(data.todoDueAccount)}"`
      + ` role="img" aria-label="${escapeHtml(label())}" title="${escapeHtml(label())}"${isDue(task) ? '' : ' hidden'}></span>`;
  }
  function scopeDotHtml(pid) {
    return `<span class="task-unread-dot todo-due-dot" data-todo-due-scope="${escapeHtml(pid || '')}"`
      + ` role="img" aria-label="${escapeHtml(label())}" title="${escapeHtml(label())}"${hasScope(pid) ? '' : ' hidden'}></span>`;
  }
  function paint() {
    ensureAccount();
    scopes = new Set(rows.filter(task => isDue(task)).map(task => task.project_id || ''));
    const entry = document.getElementById('todos-due-dot');
    if (entry) decorate(entry, scopes.size > 0);
    for (const dot of document.querySelectorAll('[data-todo-due-scope]')) {
      decorate(dot, hasScope(dot.dataset.todoDueScope));
    }
    for (const dot of document.querySelectorAll('[data-todo-due-date]')) {
      decorate(dot, dot.dataset.todoDueAccount === owner()
        && isDue({ status: dot.dataset.todoDueStatus, due_at: dot.dataset.todoDueDate }));
    }
    const tab = document.getElementById('project-todo-due-dot');
    const pid = typeof _projectDetailPid === 'string' ? _projectDetailPid : '';
    if (tab) decorate(tab, !!pid && hasScope(pid));
    if (typeof _refreshUnreadTaskIndicators === 'function') _refreshUnreadTaskIndicators();
  }
  function armMidnight() {
    clearTimeout(midnight);
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    midnight = setTimeout(() => { paint(); armMidnight(); }, next.getTime() - now.getTime() + 50);
  }
  function invalidate() {
    ++revision;
    dirty = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void refresh(); }, 150);
  }
  function refresh() {
    ensureAccount();
    clearTimeout(debounce);
    debounce = null;
    dirty = true;
    if (loading) return loading;
    // A write during a read invalidates it immediately. Drain once more using
    // current account/state, with at most one IPC request in flight.
    loading = (async () => {
      while (dirty) {
        dirty = false;
        ensureAccount();
        if (!account) break;
        const user = account, version = revision;
        try {
          const result = await window.orkas.invoke('projects.tasks.listOpen', { dueSummary: true });
          if (user !== owner() || version !== revision) { dirty = true; continue; }
          if (result?.ok === false || !Array.isArray(result?.tasks)) throw new Error('invalid_response');
          rows = result.tasks;
          paint();
        } catch (_) {
          // Keep the last known snapshot; foreground or the next change retries.
          log.warn('due to-do attention unavailable');
        }
      }
    })().finally(() => { loading = null; });
    return loading;
  }
  function init() {
    ensureAccount();
    paint();
    armMidnight();
    if (!bound) {
      bound = true;
      const foreground = () => {
        if (document.visibilityState === 'hidden') return;
        paint(); armMidnight(); invalidate();
      };
      window.addEventListener('focus', foreground);
      document.addEventListener('visibilitychange', foreground);
      window.addEventListener('i18n-change', paint);
      window.orkas.onPushEvent('projects:tasks-changed', invalidate);

    }
    return refresh();
  }
  window.TodoDue = { init, refresh, paint, isDue, hasScope, hasProjects, createDot, dotHtml, scopeDotHtml };
})();
