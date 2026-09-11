// Account-wide view over global and project-scoped to-dos. Writes, attachments
// and row actions share the editor and projects.tasks IPC routes with the
// project-detail backlog.
let _globalTodoGroups = [];
let _globalTodoProjects = [];
let _globalTodoMode = 'project';
let _globalTodoLoadSeq = 0;
let _globalTodoRefreshTimer = null;
// True until a full load commits (and again after any failed load): a change
// that arrives before then must not narrow the page to the changed scope.
let _globalTodoNeedsFullLoad = true;
// Scopes ('' = global, else a project id) whose tasks changed since the last
// paint. A change reloads only its scope; everything else stays as painted.
const _globalTodoDirtyScopes = new Set();
const _globalTodoDriverMutating = new Set();

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
  return _globalTodoContext('') || {
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
    return { project, tasks: globalRes.tasks, agents: agentRes.agents.filter((a) => a.enabled !== false), driverEnabled: !!globalDriver?.config?.enabled };
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
    agents: bindings.agentDetails || [],
    driverEnabled: !!driver?.config?.enabled,
  };
}

async function loadGlobalTodos() {
  const seq = ++_globalTodoLoadSeq;
  _globalTodoNeedsFullLoad = true;
  const host = document.getElementById('todos-content');
  host?.setAttribute('aria-busy', 'true');
  _bindProjectTodos();
  try {
    const res = await window.orkas.invoke('projects.list', {});
    if (!res?.ok || !Array.isArray(res.projects)) throw new Error('load_failed');
    const projects = res.projects.slice().sort((a, b) => a.name.localeCompare(b.name));
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
  } catch (_) {
    if (seq !== _globalTodoLoadSeq || currentView !== 'todos') return;
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

function _setGlobalTodoDriverButtons(pid, enabled, disabled = false) {
  for (const button of document.querySelectorAll('.todo-scope-driver-toggle')) {
    if ((button.dataset.pid || '') !== pid) continue;
    button.setAttribute('aria-pressed', String(enabled));
    button.disabled = disabled;
  }
}

async function _toggleGlobalTodoDriver(group) {
  const pid = group.project.project_id || '';
  if (_globalTodoDriverMutating.has(pid)) return;
  const next = !group.driverEnabled;
  _globalTodoDriverMutating.add(pid);
  _setGlobalTodoDriverButtons(pid, group.driverEnabled, true);
  try {
    const res = await window.orkas.invoke('projects.driver.set', { projectId: pid, enabled: next });
    group.driverEnabled = !!res?.config?.enabled;
    _setGlobalTodoDriverButtons(pid, group.driverEnabled);
    if (typeof uiToast === 'function') {
      uiToast(t(group.driverEnabled ? 'project.driver.enabled_toast' : 'project.driver.disabled_toast'), {
        variant: group.driverEnabled ? 'success' : 'info',
      });
    }
  } catch (err) {
    _projectDetailLog.warn('toggle todo scope driver failed', err);
    _setGlobalTodoDriverButtons(pid, group.driverEnabled);
    if (typeof uiAlert === 'function') uiAlert(t('project.todo.failed'));
  } finally {
    _globalTodoDriverMutating.delete(pid);
  }
}

function _renderGlobalTodoDriverToggle(group, showScope) {
  const pid = group.project.project_id || '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm project-driver-toggle todo-scope-driver-toggle';
  button.dataset.pid = pid;
  button.setAttribute('aria-pressed', String(!!group.driverEnabled));
  button.title = `${group.project.name} · ${t('project.driver.toggle_hint')}`;
  if (showScope) {
    const folder = typeof uiIconHtml === 'function'
      ? uiIconHtml('folder', 'todo-driver-scope-icon')
      : '';
    button.innerHTML = folder + `<span>${escapeHtml(group.project.name)}</span>`;
  } else {
    button.textContent = t('project.driver.toggle');
  }
  button.addEventListener('click', () => _toggleGlobalTodoDriver(group));
  return button;
}

function _renderGlobalTodoDriverHint() {
  const hint = document.createElement('span');
  hint.className = 'form-hint';
  hint.textContent = t('project.driver.toggle_hint');
  return hint;
}

function _renderGlobalTodoDriverBar(groups) {
  const bar = document.createElement('div');
  bar.className = 'todo-driver-bar';
  const label = document.createElement('span');
  label.className = 'todo-driver-bar-label';
  label.textContent = t('project.driver.toggle');
  bar.appendChild(label);
  for (const group of groups) bar.appendChild(_renderGlobalTodoDriverToggle(group, true));
  bar.appendChild(_renderGlobalTodoDriverHint());
  return bar;
}

function _renderGlobalTodos() {
  const host = document.getElementById('todos-content');
  if (!host) return;
  host.innerHTML = '';
  for (const button of document.querySelectorAll('[data-todo-group]')) {
    button.setAttribute('aria-pressed', String(button.dataset.todoGroup === _globalTodoMode));
  }
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
    const tasks = groups.flatMap((group) => group.tasks.map((task) => ({ ...task, project_id: group.project.project_id })));
    host.appendChild(_renderGlobalTodoDriverBar(groups));
    host.appendChild(_renderTodoBoard(tasks, {
      resolve: (task) => _globalTodoContext(task.project_id, true),
    }, 'global:status'));
    return;
  }
  for (const group of groups) {
    const pid = group.project.project_id;
    const section = document.createElement('section');
    section.className = 'todo-project-group auto-group';
    section.dataset.pid = pid;
    const header = document.createElement('div');
    header.className = 'todo-project-head auto-group-head';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'todo-collapse auto-group-toggle';
    const key = 'global:project:' + pid;
    const collapsed = _todoCollapsed.get(key) || false;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const folder = typeof uiIconHtml === 'function'
      ? `<span class="auto-group-icon">${uiIconHtml(collapsed ? 'folder' : 'folder-open', 'auto-group-folder-icon')}</span>`
      : '';
    toggle.innerHTML = folder + '<strong class="auto-group-name">' + escapeHtml(group.project.name)
      + '</strong><span class="auto-group-count">' + group.tasks.length + '</span>';
    const board = _renderTodoBoard(group.tasks, _globalTodoContext(pid), key);
    board.className += ' auto-group-list';
    board.hidden = collapsed;
    toggle.addEventListener('click', () => {
      board.hidden = !board.hidden;
      _todoCollapsed.set(key, board.hidden);
      toggle.setAttribute('aria-expanded', String(!board.hidden));
      if (typeof uiIconHtml === 'function') {
        const icon = toggle.querySelector('.auto-group-icon');
        if (icon) icon.innerHTML = uiIconHtml(board.hidden ? 'folder' : 'folder-open', 'auto-group-folder-icon');
      }
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'project-todo-menu todo-project-add';
    add.setAttribute('aria-label', t('project.todo.add') + ' · ' + group.project.name);
    add.innerHTML = typeof uiIconHtml === 'function' ? uiIconHtml('plus') : '+';
    add.addEventListener('click', () => {
      const context = _globalTodoContext(pid);
      if (!context) return;
      // A group-level + creates inside that group. The page-level + remains the
      // place for choosing a different project or the global scope.
      _openProjectTodoEditor(null, { ...context, projects: undefined });
    });
    header.appendChild(toggle);
    if (group === groups[0]) header.appendChild(_renderGlobalTodoDriverHint());
    header.appendChild(_renderGlobalTodoDriverToggle(group, false));
    header.appendChild(add);
    section.appendChild(header);
    section.appendChild(board);
    host.appendChild(section);
  }
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
      _globalTodoMode = button.dataset.todoGroup;
      _renderGlobalTodos();
    });
  }
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
