// Cleanup uses the same scope identity and durable delete route as board cards.
// Only this module owns the frozen preview; refreshes cannot widen a confirmed run.
function _todoCleanupMatches(task, project, filters, cutoff) {
  if (filters.project !== 'all' && (project.project_id || '') !== filters.project) return false;
  if (filters.status !== 'all' && task.status !== filters.status) return false;
  const updated = Date.parse(task.updated_at || task.created_at);
  return Number.isFinite(updated) && updated < cutoff;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { _todoCleanupMatches };

if (typeof document !== 'undefined') (() => {
  const log = createLogger('todo-cleanup');
  const el = id => document.getElementById(id);
  const user = () => typeof currentUserId === 'string' ? currentUserId : '';
  const tr = (key, values) => t('todo.cleanup.' + key, values);
  const picks = {};
  let owner = '', generation = 0, groups = [], locked = false, scope = '', loading = false, busy = false, confirming = false, stopped = false;
  let timer = null, returnFocus = null, shown = 50, matches = [], eligibleTotal = 0, feedback = '', error = false, cutoff = 0, pendingRefresh = false;
  let filters = { project: 'all', days: '30', status: 'done' };
  const isOpen = () => !!el('cleanup-overlay')?.classList.contains('open');
  const isCurrent = token => token === generation && owner === user() && isOpen();
  const closePicks = () => Object.values(picks).forEach(pick => pick.close());
  async function invoke(channel, payload = {}) {
    if (owner !== user()) throw new Error('cleanup_account_changed');
    const account = owner;
    const result = await window.orkas.invoke(channel, payload);
    if (account !== user() || account !== owner) throw new Error('cleanup_account_changed');
    if (!result?.ok) throw new Error('cleanup_failed');
    return result;
  }
  function controls() {
    for (const [key, pick] of Object.entries(picks)) {
      const disabled = loading || busy || confirming || (key === 'project' && locked);
      pick.el.querySelector('.ai-select-trigger').disabled = disabled;
      if (disabled) pick.close();
    }
    el('scope-lock').hidden = !locked;
    el('cleanup-cancel').textContent = t(busy ? 'chat.task_stop' : 'common.cancel');
    el('cleanup-cancel').disabled = confirming || (busy && stopped);
    el('cleanup-confirm').textContent = tr('count', { n: eligibleTotal });
    el('cleanup-confirm').disabled = loading || busy || confirming || error || !eligibleTotal;
    el('cleanup-list').setAttribute('aria-busy', String(loading || busy));
    el('cleanup-feedback').hidden = !feedback && !loading;
    el('cleanup-feedback').textContent = loading ? t('common.loading') : feedback;
    el('cleanup-feedback').classList.toggle('is-error', error);
  }
  function options() {
    const all = { value: 'all', label: tr('all') };
    picks.project.setOptions([all, ...groups.map(({ project }) => ({
      value: project.project_id || '', label: project.project_id ? project.name : t('todo.global'),
      iconName: project.project_id ? 'folder' : '',
    }))], { value: filters.project });
    picks.days.setOptions([7, 14, 30, 60, 90, 180].map(n => ({ value: String(n), label: t('settings.cleanup.days', { n }) })), { value: filters.days });
    picks.status.setOptions([all, ..._PROJECT_TODO_STATUSES.map(value => ({ value, label: t('project.todo.status_' + value) }))], { value: filters.status });
    for (const [key, label] of Object.entries({ project: t('todo.project'), days: tr('age'), status: t('todo.status') })) picks[key].setAriaLabel(label);
  }
  function renderList() {
    const list = el('cleanup-list');
    const moreFocused = document.activeElement?.id === 'cleanup-more';
    const scroll = list.scrollTop;
    const icon = name => uiIconHtml(name, 'ui-icon');
    list.innerHTML = matches.slice(0, shown).map(({ task, group }) => {
      const project = group.project;
      const projectName = project.project_id ? project.name : t('todo.global');
      const date = new Date(task.updated_at || task.created_at);
      const locale = getLocaleMeta(getLang()).intlLocale;
      return `<div class="todo-cleanup-row" role="listitem"><div class="todo-cleanup-row-copy"><div class="todo-cleanup-row-title" title="${escapeHtml(task.content)}">${escapeHtml(task.content)}</div><div class="todo-cleanup-row-meta"><span>${icon('folder')}<span class="meta-name" title="${escapeHtml(projectName)}">${escapeHtml(projectName)}</span></span></div></div><div class="todo-cleanup-row-side"><span class="btn btn-sm project-todo-status-select is-${_todoBoardStatus(task.status)}"><span class="project-todo-status-dot"></span>${escapeHtml(t('project.todo.status_' + _todoBoardStatus(task.status)))}</span><time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleDateString(locale))}</time></div></div>`;
    }).join('') || `<div class="todo-cleanup-empty" role="status">${icon('search')}<p>${escapeHtml(tr('empty'))}</p><p>${escapeHtml(tr('empty_hint'))}</p></div>`;
    if (shown < matches.length) {
      const more = document.createElement('button');
      more.type = 'button'; more.id = 'cleanup-more'; more.className = 'btn btn-sm todo-cleanup-more';
      more.textContent = t('common.more'); more.disabled = busy || confirming;
      more.addEventListener('click', () => { shown += 50; renderList(); });
      list.appendChild(more);
    }
    list.scrollTop = scroll;
    if (moreFocused) (el('cleanup-more') || list).focus({ preventScroll: true });
  }
  function filter(reset = true) {
    if (reset) { shown = 50; el('cleanup-list').scrollTop = 0; }
    options();
    matches = groups.flatMap(group => group.tasks.filter(task => _todoCleanupMatches(task, group.project, filters, cutoff))
      .map(task => ({ task, group })));
    matches.sort((a, b) => Date.parse(b.task.updated_at || b.task.created_at) - Date.parse(a.task.updated_at || a.task.created_at)
      || a.task.id.localeCompare(b.task.id));
    eligibleTotal = matches.length;
    el('match-count').textContent = matches.length;
    renderList(); controls();
  }
  async function refresh({ retainFeedback = false } = {}) {
    if (!isOpen() || busy || confirming) return;
    if (loading) { pendingRefresh = true; return; }
    const token = ++generation;
    loading = true; error = false;
    if (!retainFeedback) feedback = '';
    controls();
    try {
      const projects = locked
        ? [((await invoke('projects.get', { projectId: scope })).project)]
        : [{ project_id: '', name: t('todo.global') }, ...(await invoke('projects.list')).projects];
      if (!isCurrent(token)) return;
      if (!Array.isArray(projects) || projects.some(project => !project)) throw new Error('cleanup_failed');
      const loaded = []; let taskCount = 0;
      // Same four-scope bound as the account board. No history or agent hydration.
      for (let start = 0; start < projects.length; start += 4) {
        if (!isCurrent(token)) return;
        const batch = await Promise.all(projects.slice(start, start + 4).map(async project => {
          const tasks = await invoke('projects.tasks.list', { projectId: project.project_id || '' });
          if (!Array.isArray(tasks.tasks)) throw new Error('cleanup_failed');
          return { project, tasks: tasks.tasks };
        }));
        loaded.push(...batch);
        taskCount += batch.reduce((n, group) => n + group.tasks.length, 0);
        if (taskCount > 50000) throw new Error('cleanup_limit');
      }
      if (!isCurrent(token)) return;
      groups = loaded;
      if (filters.project !== 'all' && !groups.some(group => (group.project.project_id || '') === filters.project)) filters.project = 'all';
      cutoff = Date.now() - Number(filters.days) * 86400000;
      loading = false; filter(false);

    } catch (_) {
      if (!isCurrent(token)) return;
      groups = []; matches = []; eligibleTotal = 0; error = true;
      feedback = (retainFeedback && feedback ? feedback + ' ' : '') + t('todo.load_failed');
      el('match-count').textContent = '—';
      el('cleanup-list').innerHTML = `<div class="todo-cleanup-empty"><button type="button" class="btn btn-sm" id="cleanup-retry">${escapeHtml(t('chat.retry_btn'))}</button></div>`;
      el('cleanup-retry').addEventListener('click', () => refresh());
      log.warn('cleanup preview load failed');
    } finally {
      if (isCurrent(token)) {
        loading = false; controls();
        if (pendingRefresh) { pendingRefresh = false; clearTimeout(timer); timer = setTimeout(() => refresh({ retainFeedback: true }), 150); }
      }
    }
  }
  function close() {
    if (busy || confirming) return;
    closePicks(); clearTimeout(timer); generation++;
    el('cleanup-overlay').classList.remove('open');
    el('cleanup-overlay').setAttribute('aria-hidden', 'true');
    groups = []; matches = []; eligibleTotal = 0; loading = false; pendingRefresh = false;
    _uiRestoreDialogFocus(returnFocus);
  }
  async function open(projectId) {
    if (busy || confirming) return;
    owner = user(); if (!owner) return;
    locked = typeof projectId === 'string'; scope = projectId || '';
    returnFocus = document.activeElement;
    filters = { project: locked ? scope : 'all', days: '30', status: 'done' };
    shown = 50; feedback = ''; groups = []; matches = []; eligibleTotal = 0; error = false; loading = false; pendingRefresh = false;
    el('match-count').textContent = '—';
    el('cleanup-list').innerHTML = `<div class="todo-cleanup-empty" role="status">${escapeHtml(t('common.loading'))}</div>`;
    el('cleanup-overlay').classList.add('open');
    el('cleanup-overlay').setAttribute('aria-hidden', 'false');
    el('cleanup-cancel').focus();
    await refresh();
  }
  async function run() {
    if (loading || busy || confirming || owner !== user()) return;
    const selected = matches.slice();
    if (!selected.length) return;
    const account = owner;
    confirming = true; closePicks(); controls();
    const confirmed = await uiConfirmDanger({ title: tr('confirm_title', { n: selected.length }),
      message: tr('confirm_message', { n: selected.length }), dangerLabel: tr('count', { n: selected.length }) });
    confirming = false;
    if (account !== user() || !isOpen()) { controls(); return; }
    if (!confirmed) { controls(); return; }
    busy = true; stopped = false; error = false; controls();
    _projectTodoMutating = true;
    _projectTodoLoadSeq++;
    if (typeof _invalidateGlobalTodoLoad === 'function') _invalidateGlobalTodoLoad();
    const result = { deleted: 0, skipped: 0, failed: 0 };
    let completed = 0;
    try { for (const row of selected) {
      if (account !== user() || stopped) break;
      feedback = t('settings.cleanup.progress', { done: completed, total: selected.length }); controls();
      const { task, group } = row;
      try {
        const response = await invoke('projects.tasks.delete', { projectId: group.project.project_id || '', taskId: task.id,
          expectedUserId: account, expectedTask: {
            content: task.content, status: task.status, created_at: task.created_at, updated_at: task.updated_at,
          } });
        if (response.skipped) result.skipped++;
        else result.deleted++;
      } catch (_) { result.failed++; }
      completed++;
    } } finally { busy = false; _projectTodoMutating = false; }
    if (account !== user()) { close(); return; }
    feedback = tr('result', result) + (result.skipped ? ' ' + tr('skipped_hint') : '');
    await refresh({ retainFeedback: true });
    if (currentView === 'todos') void _refreshGlobalTodos();
    else if (currentView === 'project' && _projectDetailPid) void _loadProjectTodos(_projectDetailPid);
    _applyPendingTodoGrouping();
  }
  function init() {
    if (!el('cleanup-overlay')) return;
    for (const [key, id] of Object.entries({ project: 'cleanup-project', days: 'cleanup-age', status: 'cleanup-status' })) {
      picks[key] = _aiSelectMount(el(id), { options: [], value: '', onChange: value => {
        if (busy || loading || confirming || owner !== user()) return;
        filters[key] = value; feedback = ''; cutoff = Date.now() - Number(filters.days) * 86400000; filter();
      } });
    }
    el('todos-cleanup-btn')?.addEventListener('click', () => open());
    el('project-todo-cleanup-btn')?.addEventListener('click', () => open(_projectDetailPid));
    el('cleanup-cancel').addEventListener('click', () => {
      if (busy) { stopped = true; controls(); } else close();
    });
    el('cleanup-confirm').addEventListener('click', run);
    const overlay = el('cleanup-overlay');
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', event => {
      if (!isOpen() || !_uiIsTopDialogOverlay(overlay) || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (_uiTrapDialogTab(overlay, event)) return;
      if (event.key === 'Escape') {
        // The shared select owns the first Escape, regardless of listener order.
        if (Object.values(picks).some(pick => pick.state.open)) { closePicks(); event.preventDefault(); return; }
        event.preventDefault(); close();
      }
    });
    window.addEventListener('i18n-change', () => { if (isOpen() && !loading) filter(false); });
    window.orkas.onPushEvent('projects:tasks-changed', () => {
      if (!isOpen() || busy || confirming) return;
      clearTimeout(timer); timer = setTimeout(() => refresh({ retainFeedback: true }), 150);
    });
  }
  window.TodoCleanup = { deferRefresh: () => busy };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
