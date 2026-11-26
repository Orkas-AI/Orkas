// Account-wide view over global and project-scoped to-dos. Writes, attachments
// and row actions share the editor and projects.tasks IPC routes with the
// project-detail backlog.
let _globalTodoGroups = [];
let _globalTodoProjects = [];
let _globalTodoMode = 'project';
// Presentation-only: the by-project view paints one scope at a time ('' is the
// global scope). Never persisted, and never narrows what a load fetches.
let _globalTodoActiveScope = null;
let _globalTodoLoadSeq = 0;
let _globalTodoRefreshTimer = null;
// True until a full load commits (and again after any failed load): a change
// that arrives before then must not narrow the page to the changed scope.
let _globalTodoNeedsFullLoad = true;
// Scopes ('' = global, else a project id) whose tasks changed since the last
// paint. A change reloads only its scope; everything else stays as painted.
const _globalTodoDirtyScopes = new Set();
const _globalTodoDriverMutating = new Set();
// A to-do the home asked to show; applied once by the next full load.
let _globalTodoPendingFocus = null;
let _todoGroupingState = null;
let _todoGroupingDragging = false;

function _todoGroupingAccountState() {
  const uid = typeof currentUserId === 'string' ? currentUserId : '';
  if (!_todoGroupingState || _todoGroupingState.uid !== uid) {
    if (_todoGroupingState) _globalTodoMode = 'project';
    _todoGroupingState = { uid, revision: 0, read: 0, writes: 0,
      chain: Promise.resolve(), pending: null, refresh: false };
  }
  return _todoGroupingState;
}

function _todoGroupingIsCurrent(state) {
  return state === _todoGroupingState
    && state.uid === (typeof currentUserId === 'string' ? currentUserId : '');
}

function _todoGroupingBusy() {
  return _todoGroupingDragging || document.getElementById('todo-editor-modal')?.classList?.contains('open')
    || (typeof _projectTodoMutating !== 'undefined' && _projectTodoMutating);
}

function _applyTodoGrouping(grouping, render = true) {
  const state = _todoGroupingAccountState();
  if (_todoGroupingBusy()) { state.pending = grouping; return; }
  state.pending = null;
  const changed = _globalTodoMode !== grouping;
  _globalTodoMode = grouping;
  _syncTodoGroupingButtons();
  if (changed && render && currentView === 'todos') _renderGlobalTodos();
}

function _syncTodoGroupingButtons() {
  for (const button of document.querySelectorAll?.('[data-todo-group]') || []) {
    button.setAttribute('aria-pressed', String(button.dataset.todoGroup === _globalTodoMode));
  }
}

function _applyPendingTodoGrouping() {
  const state = _todoGroupingAccountState();
  if (state.pending) _applyTodoGrouping(state.pending);
}

async function refreshTodoGroupingFromMain({ render = true } = {}) {
  const state = _todoGroupingAccountState();
  if (!state.uid) return;
  if (state.writes) { state.refresh = true; return; }
  const read = ++state.read, revision = state.revision;
  try {
    const result = await window.orkas.invoke('prefs.getTodoGrouping');
    if (!_todoGroupingIsCurrent(state) || read !== state.read || revision !== state.revision) return;
    if (!result?.ok) throw new Error('todo grouping read failed');
    _applyTodoGrouping(result.grouping === 'status' ? 'status' : 'project', render);
  } catch (_) {
    if (_todoGroupingIsCurrent(state)) _projectDetailLog.warn('todo grouping read failed');
  }
}

function _chooseTodoGrouping(grouping) {
  if (grouping !== 'project' && grouping !== 'status') return Promise.resolve();
  const state = _todoGroupingAccountState();
  const revision = ++state.revision;
  state.pending = null;
  _applyTodoGrouping(grouping);
  if (!state.uid) return Promise.resolve();
  state.writes += 1;
  const save = state.chain.then(async () => {
    if (!_todoGroupingIsCurrent(state)) return;
    const result = await window.orkas.invoke('prefs.setTodoGrouping', { grouping });
    if (!result?.ok) throw new Error('todo grouping save failed');
  }).catch(() => {
    if (_todoGroupingIsCurrent(state) && revision === state.revision) {
      _projectDetailLog.warn('todo grouping save failed');
      if (typeof uiToast === 'function') uiToast(t('project.todo.failed'));
      state.refresh = true;
    }
  }).finally(async () => {
    state.writes -= 1;
    if (_todoGroupingIsCurrent(state) && !state.writes && state.refresh) {
      state.refresh = false;
      await refreshTodoGroupingFromMain();
    }
  });
  state.chain = save;
  return save;
}

function _globalTodoContext(pid, showProject = false) {
  const group = _globalTodoGroups.find((item) => item.project.project_id === pid);
  if (!group) return null;
  return {
    pid, tasks: group.tasks, agents: group.agents,
    project: group.project, showProject, global: !pid,
    projects: _globalTodoProjects,
  };
}

function _globalTodoCreateContext() {
  const pid = _globalTodoMode === 'project' && _globalTodoScopeProject(_globalTodoActiveScope)
    ? (_globalTodoActiveScope || '') : '';
  return _globalTodoContext(pid) || _globalTodoContext('') || {
    pid: '',
    tasks: [],
    agents: [],
    project: { project_id: '', name: t('todo.global') },
    global: true,
  };
}

function _globalTodoScopeProject(pid) {
  if (!pid) return { project_id: '', name: t('todo.global') };
  return _globalTodoProjects.find((project) => project.project_id === pid) || null;
}

// One backlog section: the global scope or one project. `null` when the scope
// holds no task, which is also when the page shows no section for it.
async function _loadGlobalTodoGroup(project) {
  const pid = project.project_id || '';
  if (!pid) {
    const [globalRes, globalDriver, agentRes] = await Promise.all([
      window.orkas.invoke('projects.tasks.list', {}),
      window.orkas.invoke('projects.driver.get', { projectId: '' }),
      window.orkas.invoke('agents.list', { summary: true }),
    ]);
    if (!globalRes?.ok || !Array.isArray(globalRes.tasks)) throw new Error('load_failed');
    if (!globalRes.tasks.length) return null;
    if (!Array.isArray(agentRes?.agents)) throw new Error('load_failed');
    return { project, tasks: globalRes.tasks, agents: agentRes.agents.filter((a) => a.enabled !== false),
      driverEnabled: !!globalDriver?.config?.enabled, driverConfig: globalDriver?.config, driverDevice: globalDriver?.device };
  }
  const tasks = await window.orkas.invoke('projects.tasks.list', { projectId: pid });
  if (!tasks?.ok || !Array.isArray(tasks.tasks)) throw new Error('load_failed');
  if (!tasks.tasks.length) return null;
  const [bindings, driver] = await Promise.all([
    window.orkas.invoke('projects.bindings.list', { projectId: pid }),
    window.orkas.invoke('projects.driver.get', { projectId: pid }),
  ]);
  if (!bindings?.ok) throw new Error('load_failed');
  return {
    project,
    tasks: tasks.tasks,
    agents: _projectAvailableAgents(bindings),
    driverEnabled: !!driver?.config?.enabled,
    driverConfig: driver?.config,
    driverDevice: driver?.device,
  };
}

async function loadGlobalTodos() {
  const seq = ++_globalTodoLoadSeq;
  _globalTodoNeedsFullLoad = true;
  const host = document.getElementById('todos-content');
  host?.setAttribute('aria-busy', 'true');
  _bindProjectTodos();
  try {
    const [res] = await Promise.all([
      window.orkas.invoke('projects.list', {}), refreshTodoGroupingFromMain({ render: false }),
    ]);
    if (!res?.ok || !Array.isArray(res.projects)) throw new Error('load_failed');
    const projects = res.projects;
    const globalGroup = await _loadGlobalTodoGroup(_globalTodoScopeProject(''));
    const groups = globalGroup ? [globalGroup] : [];
    // Bound filesystem/IPC fan-out; a stale visit stops scheduling more work.
    for (let offset = 0; offset < projects.length; offset += 4) {
      if (seq !== _globalTodoLoadSeq || currentView !== 'todos') return;
      const batch = await Promise.all(projects.slice(offset, offset + 4).map(_loadGlobalTodoGroup));
      groups.push(...batch.filter(Boolean));
    }
    if (seq !== _globalTodoLoadSeq || currentView !== 'todos') return;
    _globalTodoGroups = groups;
    _globalTodoProjects = projects;
    _globalTodoNeedsFullLoad = false;
    _globalTodoDirtyScopes.clear();
    document.getElementById('todos-error').hidden = true;
    _renderGlobalTodos();
    _applyGlobalTodoPendingFocus();
  } catch (_) {
    if (seq !== _globalTodoLoadSeq || currentView !== 'todos') return;
    _globalTodoPendingFocus = null;
    _projectDetailLog.warn('load global todos failed');
    document.getElementById('todos-error').hidden = false;
  } finally {
    if (seq === _globalTodoLoadSeq) host?.setAttribute('aria-busy', 'false');
  }
}

// Reload only the changed scopes and splice them into the painted page in the
// full load's order (global first, then projects as sorted there).
async function _reloadGlobalTodoScopes(pids) {
  const seq = ++_globalTodoLoadSeq;
  const host = document.getElementById('todos-content');
  host?.setAttribute('aria-busy', 'true');
  try {
    const reloaded = await Promise.all(pids.map((pid) => _loadGlobalTodoGroup(_globalTodoScopeProject(pid))));
    if (seq !== _globalTodoLoadSeq || currentView !== 'todos') {
      // Superseded before it could paint: the scopes are still unpainted.
      pids.forEach((pid) => _globalTodoDirtyScopes.add(pid));
      return;
    }
    const byPid = new Map(_globalTodoGroups.map((group) => [group.project.project_id || '', group]));
    pids.forEach((pid, index) => {
      if (reloaded[index]) byPid.set(pid, reloaded[index]);
      else byPid.delete(pid);
    });
    _globalTodoGroups = ['', ..._globalTodoProjects.map((project) => project.project_id)]
      .map((pid) => byPid.get(pid))
      .filter(Boolean);
    document.getElementById('todos-error').hidden = true;
    _renderGlobalTodos();
  } catch (_) {
    if (seq !== _globalTodoLoadSeq || currentView !== 'todos') {
      // Failure still leaves these scopes unpainted. Preserve them just as
      // for a superseded success so another project's refresh cannot lose them.
      pids.forEach((pid) => _globalTodoDirtyScopes.add(pid));
      return;
    }
    _projectDetailLog.warn('load global todos failed');
    _globalTodoNeedsFullLoad = true;
    document.getElementById('todos-error').hidden = false;
  } finally {
    if (seq === _globalTodoLoadSeq) host?.setAttribute('aria-busy', 'false');
  }
}

function _globalTodoScopeName(project) {
  return project.project_id ? project.name : t('todo.global');
}

function _setGlobalTodoDriverButtonState(button, group, disabled = false) {
  const name = _todoDriverDeviceName(group.driverConfig, group.driverDevice);
  const suffix = name ? ' · ' + name : '';
  button.setAttribute('aria-pressed', String(!!group.driverEnabled));
  button.disabled = disabled;
  const scopeName = _globalTodoScopeName(group.project);
  button.title = `${scopeName} · ${t('project.driver.toggle_hint')}${suffix}`;
  const label = (button.dataset.showScope === '1' ? scopeName : t('project.driver.toggle')) + suffix;
  button.setAttribute('aria-label', label);
  const toggle = '<span class="project-driver-switch" aria-hidden="true"></span>';
  if (button.dataset.showScope === '1') {
    const folder = typeof uiIconHtml === 'function'
      ? uiIconHtml(typeof projectIconName === 'function' ? projectIconName(group.project) : 'folder', 'todo-driver-scope-icon') : '';
    button.innerHTML = toggle + folder + `<span>${escapeHtml(label)}</span>`;
  } else {
    button.innerHTML = toggle + `<span>${escapeHtml(label)}</span>`;
  }
}

function _setGlobalTodoDriverButtons(pid, group, disabled = false) {
  for (const button of document.querySelectorAll('.todo-scope-driver-toggle')) {
    if ((button.dataset.pid || '') !== pid) continue;
    _setGlobalTodoDriverButtonState(button, group, disabled);
  }
}

async function _toggleGlobalTodoDriver(group) {
  const pid = group.project.project_id || '';
  if (_globalTodoDriverMutating.has(pid)) return;
  const next = !group.driverEnabled;
  _globalTodoDriverMutating.add(pid);
  _setGlobalTodoDriverButtons(pid, group, true);
  try {
    const res = await window.orkas.invoke('projects.driver.set', { projectId: pid, enabled: next });
    if (res?.ok === false || !res?.config) throw new Error('toggle_failed');
    group.driverEnabled = !!res?.config?.enabled;
    group.driverConfig = res.config;
    group.driverDevice = res.device;
    _setGlobalTodoDriverButtons(pid, group);
    if (typeof uiToast === 'function') {
      uiToast(t(group.driverEnabled ? 'project.driver.enabled_toast' : 'project.driver.disabled_toast'), {
        variant: group.driverEnabled ? 'success' : 'info',
      });
    }
  } catch (err) {
    _projectDetailLog.warn('toggle todo scope driver failed', err);
    _setGlobalTodoDriverButtons(pid, group);
    if (typeof uiAlert === 'function') uiAlert(t('project.todo.failed'));
  } finally {
    _globalTodoDriverMutating.delete(pid);
  }
}

function _renderGlobalTodoDriverToggle(group, showScope) {
  const pid = group.project.project_id || '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'project-driver-toggle is-switch todo-scope-driver-toggle';
  button.dataset.pid = pid;
  button.dataset.showScope = showScope ? '1' : '0';
  _setGlobalTodoDriverButtonState(button, group, _globalTodoDriverMutating.has(pid));
  button.addEventListener('click', () => _toggleGlobalTodoDriver(group));
  return button;
}

function _renderGlobalTodoDriverHint() {
  _bindProjectDriverHint();
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'project-driver-hint';
  hint.setAttribute('aria-label', t('project.driver.toggle_hint'));
  hint.setAttribute('aria-describedby', 'project-driver-tooltip');
  hint.innerHTML = uiIconHtml('info', 'project-driver-hint-icon');
  return hint;
}

function _renderGlobalTodoDriverControl(group, showScope) {
  const control = document.createElement('div');
  control.className = 'todo-driver-control';
  control.appendChild(_renderGlobalTodoDriverToggle(group, showScope));
  control.appendChild(_renderGlobalTodoDriverHint());
  return control;
}

// One explanation serves every scope switch, so the hint follows the shared
// label instead of repeating after each switch.
function _renderGlobalTodoDriverBar(groups) {
  const bar = document.createElement('div');
  bar.className = 'todo-driver-bar';
  const head = document.createElement('div');
  head.className = 'todo-driver-bar-head';
  const label = document.createElement('span');
  label.className = 'todo-driver-bar-label';
  label.textContent = t('project.driver.toggle');
  head.appendChild(label);
  head.appendChild(_renderGlobalTodoDriverHint());
  bar.appendChild(head);
  const list = document.createElement('div');
  list.className = 'todo-driver-bar-list todo-scroll-track';
  list.dataset.track = 'status-driver';
  for (const group of groups) list.appendChild(_renderGlobalTodoDriverToggle(group, true));
  _bindTodoScrollTrack(list);
  bar.appendChild(list);
  return bar;
}

function _renderGlobalTodoScopeSwitcher(groups) {
  const nav = document.createElement('nav');
  nav.className = 'todo-scope-switcher todo-scroll-track';
  nav.dataset.track = 'project-scope';
  nav.setAttribute('aria-label', t('todo.by_project'));
  for (const group of groups) {
    const pid = group.project.project_id || '';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'todo-scope-chip';
    chip.dataset.pid = pid;
    chip.setAttribute('aria-pressed', String(pid === _globalTodoActiveScope));
    const folder = typeof uiIconHtml === 'function'
      ? uiIconHtml(typeof projectIconName === 'function' ? projectIconName(group.project) : 'folder', 'todo-scope-chip-icon')
      : '';
    chip.innerHTML = folder
      + `<span class="todo-scope-chip-name">${escapeHtml(_globalTodoScopeName(group.project))}</span>`
      + (window.TodoDue?.scopeDotHtml(pid) || '')
      + `<span class="todo-scope-chip-count">${group.tasks.length}</span>`;
    chip.addEventListener('click', () => {
      if (_globalTodoActiveScope === pid) return;
      _globalTodoActiveScope = pid;
      _renderGlobalTodos();
    });
    nav.appendChild(chip);
  }
  _bindTodoScrollTrack(nav);
  return nav;
}

// Single-row chip tracks (project switcher, status-view switches) scroll
// sideways. Without a horizontal wheel, vertical wheel motion moves the track;
// at either end the page keeps scrolling normally.
function _bindTodoScrollTrack(track) {
  track.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const before = track.scrollLeft;
    track.scrollLeft += event.deltaY * (getComputedStyle(track).direction === 'rtl' ? -1 : 1);
    if (track.scrollLeft !== before) event.preventDefault();
  }, { passive: false });
  track.addEventListener('scroll', () => _updateTodoScrollTrackFade(track), { passive: true });
}

// Fade whichever physical edge hides chips, so an overflowing track reads as
// scrollable without a visible scrollbar.
function _updateTodoScrollTrackFade(track) {
  const max = track.scrollWidth - track.clientWidth;
  const offset = Math.abs(track.scrollLeft);
  const rtl = getComputedStyle(track).direction === 'rtl';
  const beforeStart = max > 1 && offset > 1;
  const beforeEnd = max > 1 && offset < max - 1;
  track.classList.toggle('is-fade-left', rtl ? beforeEnd : beforeStart);
  track.classList.toggle('is-fade-right', rtl ? beforeStart : beforeEnd);
}

function _captureTodoScrollTrack(host) {
  const track = host.querySelector('.todo-scroll-track');
  return track ? { key: track.dataset.track, left: track.scrollLeft } : null;
}

let _todoScrollTrackResizeObserver = null;
let _todoScrollTrackObserved = null;

// Restore the track position of the same view, then keep the active chip (if
// any, e.g. a scope picked off-screen via focusTodo) in view.
function _mountTodoScrollTrack(track, snapshot) {
  if (snapshot?.key === track.dataset.track && snapshot.left) track.scrollLeft = snapshot.left;
  const active = track.querySelector('[aria-pressed="true"].todo-scope-chip');
  if (active) {
    const bounds = track.getBoundingClientRect();
    const chip = active.getBoundingClientRect();
    if (chip.left < bounds.left || chip.right > bounds.right) {
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  _updateTodoScrollTrackFade(track);
  if (typeof ResizeObserver !== 'function') return;
  if (!_todoScrollTrackResizeObserver) {
    _todoScrollTrackResizeObserver = new ResizeObserver(() => {
      if (_todoScrollTrackObserved?.isConnected) _updateTodoScrollTrackFade(_todoScrollTrackObserved);
    });
  }
  if (_todoScrollTrackObserved) _todoScrollTrackResizeObserver.unobserve(_todoScrollTrackObserved);
  _todoScrollTrackObserved = track;
  _todoScrollTrackResizeObserver.observe(track);
}

function _renderGlobalTodos() {
  const host = document.getElementById('todos-content');
  if (!host) return;
  const scroll = _captureTodoScroll(host);
  const trackScroll = _captureTodoScrollTrack(host);
  _closeProjectDriverHint();
  _closeTodoAssignPicker(host);
  host.innerHTML = '';
  _syncTodoGroupingButtons();
  const groups = _globalTodoGroups;
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty muted';
    empty.textContent = t('todo.empty');
    host.appendChild(empty);
    return;
  }
  if (_globalTodoMode === 'status') {
    // Composite identity is necessary even when imported tasks share an id.
    const tasks = groups.flatMap((group) => group.tasks
      .map((task) => ({ ...task, project_id: group.project.project_id })));
    const bar = _renderGlobalTodoDriverBar(groups);
    host.appendChild(bar);
    _mountTodoScrollTrack(bar.querySelector('.todo-scroll-track'), trackScroll);
    host.appendChild(_renderTodoBoard(tasks, {
      resolve: (task) => _globalTodoContext(task.project_id, true),
    }, 'global:status'));
    _restoreTodoScroll(host, scroll);
    return;
  }
  const scopes = groups.map((group) => group.project.project_id || '');
  // A scope that emptied out since the last paint drops off the switcher, so
  // fall back to the first one rather than painting nothing.
  if (!scopes.includes(_globalTodoActiveScope)) _globalTodoActiveScope = scopes[0];
  // The switcher scrolls on its own while the scope's Auto-advance control
  // stays pinned at the end of the same row.
  const row = document.createElement('div');
  row.className = 'todo-scope-row';
  const switcher = _renderGlobalTodoScopeSwitcher(groups);
  row.appendChild(switcher);
  host.appendChild(row);
  for (const group of groups) {
    const pid = group.project.project_id;
    if ((pid || '') !== _globalTodoActiveScope) continue;
    const section = document.createElement('section');
    section.className = 'todo-project-group';
    section.dataset.pid = pid;
    const key = 'global:project:' + pid;
    const board = _renderTodoBoard(group.tasks, _globalTodoContext(pid), key);
    const actions = document.createElement('div');
    actions.className = 'todo-scope-actions';
    actions.appendChild(_renderGlobalTodoDriverControl(group, false));
    row.appendChild(actions);
    section.appendChild(board);
    host.appendChild(section);
  }
  _mountTodoScrollTrack(switcher, trackScroll);
  _restoreTodoScroll(host, scroll);
}

/** Open the To-dos page on one to-do in the user's chosen grouping and its
 *  scope; the row is highlighted once loaded. If it is gone by then (done or
 *  deleted meanwhile), the page simply opens. */
function focusTodo(scope, taskId, opts = {}) {
  const pid = String(scope || '');
  const id = String(taskId || '');
  _globalTodoPendingFocus = id ? { pid, id, reportMissing: opts.reportMissing === true } : null;
  if (id) {
    _globalTodoActiveScope = pid;
  }
  setView('todos', null, opts);
}

function _applyGlobalTodoPendingFocus() {
  const target = _globalTodoPendingFocus;
  _globalTodoPendingFocus = null;
  if (!target) return;
  const host = document.getElementById('todos-content');
  const row = Array.from(host?.querySelectorAll('.project-todo-item[data-tid]') || [])
    .find((el) => el.dataset.tid === target.id && (el.dataset.pid || '') === target.pid);
  if (!row) {
    if (target.reportMissing && typeof uiToast === 'function') uiToast(t('todo.notification.unavailable'));
    return;
  }
  // Reveal it even when the user had collapsed its column; this does not
  // change the remembered collapse state.
  const body = row.closest('.todo-column-body');
  if (body?.hidden) _setTodoColumnCollapsed(body, false);
  row.classList.add('is-highlighted');
  row.scrollIntoView({ block: 'center' });
  setTimeout(() => row.classList.remove('is-highlighted'), 2500);
}

// `pid` undefined reloads everything (sync refresh); '' or a project id
// reloads that scope plus any scope still pending from the debounce, unless
// the page has no committed full load to splice into.
async function _refreshGlobalTodos(pid) {
  if (currentView !== 'todos') return;
  clearTimeout(_globalTodoRefreshTimer);
  _globalTodoRefreshTimer = null;
  if (pid !== undefined && pid !== null) _globalTodoDirtyScopes.add(pid);
  const scopes = [..._globalTodoDirtyScopes];
  _globalTodoDirtyScopes.clear();
  const partial = pid !== undefined && !_globalTodoNeedsFullLoad && scopes.length > 0
    && scopes.every((scope) => !!_globalTodoScopeProject(scope));
  if (partial) await _reloadGlobalTodoScopes(scopes);
  else await loadGlobalTodos();
  // A reload superseded meanwhile handed its scopes back; drain them.
  if (_globalTodoDirtyScopes.size && currentView === 'todos' && !_globalTodoRefreshTimer) {
    _globalTodoRefreshTimer = setTimeout(() => _refreshGlobalTodos(null), 0);
  }
}

function _invalidateGlobalTodoLoad() {
  _globalTodoLoadSeq += 1;
}

function _scheduleGlobalTodosRefresh(pid) {
  if (pid === undefined || pid === null || currentView !== 'todos') return;
  _globalTodoDirtyScopes.add(pid);
  // Invalidate immediately, before the debounce expires, so an old response
  // cannot repaint a task after the write event has already arrived.
  _globalTodoLoadSeq += 1;
  clearTimeout(_globalTodoRefreshTimer);
  _globalTodoRefreshTimer = setTimeout(() => _refreshGlobalTodos(null), 150);
}

function _initGlobalTodos() {
  _bindTodoListActions(document.getElementById('todos-content'), _globalTodoContext);
  document.getElementById('todos-retry')?.addEventListener('click', loadGlobalTodos);
  for (const button of document.querySelectorAll('[data-todo-group]')) {
    button.addEventListener('click', () => {
      void _chooseTodoGrouping(button.dataset.todoGroup);
    });
  }
  const host = document.getElementById('todos-content');
  host?.addEventListener('dragstart', () => { _todoGroupingDragging = true; });
  for (const event of ['dragend', 'drop']) host?.addEventListener(event, () => {
    _todoGroupingDragging = false;
    _applyPendingTodoGrouping();
  });
  document.getElementById('todos-add-btn')?.addEventListener('click', () => {
    const context = _globalTodoCreateContext();
    _openProjectTodoEditor(null, {
      ...context,
      projects: _globalTodoProjects,
    });
  });
  window.addEventListener('i18n-change', () => {
    if (currentView === 'todos') _renderGlobalTodos();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initGlobalTodos, { once: true });
else _initGlobalTodos();
