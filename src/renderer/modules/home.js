/* Orkas Frontend — Commander home (the New task view)
 *
 * The greeting and the composer stay at the top in every state; the state
 * picks what sits below them (PC/docs/design/PATTERNS.md P15):
 * - empty: two guidance blocks and Quick start;
 * - populated: work to pick up — unfinished to-dos, and finished automation
 *   runs and tasks the user has not opened yet.
 * "Not opened yet" is the sidebar's unread record (task-unread.js), so the
 * home and the sidebar dots always agree and opening a row clears both.
 * Each visit looks both lists up once and paints when they settle. A failed
 * lookup hides its group and is only logged: there are no loading, error or
 * stale-data states.
 */

const _homeLog = createLogger('home');

const _HOME_VISIBLE_ROWS = 3;
// Unread runs missing from the sidebar cache are looked up by id, in batches
// of what `conversations.getMany` accepts, enough to fill both run groups.
const _HOME_LOOKUP_BATCH = 25;
const _HOME_LOOKUP_LIMIT = 50;
const _HOME_REFRESH_DEBOUNCE_MS = 500;
// A slow first lookup must not keep the greeting and Quick start invisible.
const _HOME_FIRST_PAINT_FALLBACK_MS = 1500;

// 'pending' only until the first visit's lookups settle; later visits keep
// the last painted state until the new lookup replaces it.
let _homeState = 'pending';
let _homeData = { todos: [], todoTotal: 0, automations: [], tasks: [] };
let _homeLoadSeq = 0; // { startedAt, reported }
let _homeRefreshTimer = null;
let _homeBound = false;
const _homeExpanded = new Set();

function _homeErrorType(err) {
  return err && typeof err.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'unknown';
}

function _homeVisible() {
  try {
    return currentView === 'new-chat';
  } catch (_) {
    return false;
  }
}

function _homeIcon(name, className) {
  return typeof window.uiIconHtml === 'function' ? window.uiIconHtml(name, className) : '';
}

// ── Lookups ─────────────────────────────────────────────────────────────

async function _homeLoadTodos() {
  try {
    const res = await window.orkas.invoke('projects.tasks.listOpen', { all: true });
    if (!res || res.ok === false || !Array.isArray(res.tasks)) throw new Error('invalid_response');
    const tasks = res.tasks;
    return { tasks, total: Math.max(tasks.length, Math.round(Number(res.total) || 0)) };
  } catch (err) {
    _homeLog.warn('open to-dos unavailable for the home', { error_type: _homeErrorType(err) });
    return { tasks: [], total: 0 };
  }
}

function _homeConversationInfo(row) {
  return {
    title: String(row.title || ''),
    projectId: String(row.project_id || ''),
    automation: !!row.origin_auto_task_id,
  };
}

/** Unread finished runs split into automation runs and other tasks, newest
 *  first. A conversation an automation created stays an automation run even
 *  when its latest turn was a reply the user wrote there. */
async function _homeLoadRuns() {
  let records = [];
  try {
    records = window.TaskUnread && typeof window.TaskUnread.list === 'function'
      ? window.TaskUnread.list()
      : [];
  } catch (err) {
    _homeLog.warn('unread tasks unavailable for the home', { error_type: _homeErrorType(err) });
  }
  const cached = new Map();
  const rows = typeof conversations !== 'undefined' && Array.isArray(conversations) ? conversations : [];
  for (const row of rows) {
    if (row && row.conversation_id) cached.set(row.conversation_id, row);
  }
  const info = new Map();
  const lookups = [];
  for (const record of records) {
    const row = cached.get(record.cid);
    if (row) info.set(record.cid, _homeConversationInfo(row));
    else if (lookups.length < _HOME_LOOKUP_LIMIT) lookups.push(record.cid);
  }
  const missing = [];
  for (let offset = 0; offset < lookups.length; offset += _HOME_LOOKUP_BATCH) {
    try {
      const res = await window.orkas.invoke('conversations.getMany', {
        cids: lookups.slice(offset, offset + _HOME_LOOKUP_BATCH),
      });
      for (const row of (res && res.conversations) || []) {
        if (row && row.conversation_id) info.set(row.conversation_id, _homeConversationInfo(row));
      }
      for (const cid of (res && res.missing) || []) missing.push(cid);
    } catch (err) {
      // The rows still show, untitled, and can be opened.
      _homeLog.warn('unread task titles unavailable for the home', { error_type: _homeErrorType(err) });
      break;
    }
  }
  // A conversation deleted elsewhere (another device) leaves its unread record
  // behind; drop it here so neither the home nor the sidebar keeps it.
  if (missing.length && typeof _forgetUnreadConversation === 'function') {
    for (const cid of missing) _forgetUnreadConversation(cid);
  }
  const gone = new Set(missing);
  const automations = [];
  const tasks = [];
  for (const record of records) {
    if (gone.has(record.cid)) continue;
    const known = info.get(record.cid);
    const run = {
      cid: record.cid,
      status: record.status || '',
      finishedAt: Number(record.finishedAt) || 0,
      title: known ? known.title : '',
      projectId: known ? known.projectId : String(record.projectId || ''),
    };
    const automation = record.entryPoint === 'automation' || !!(known && known.automation);
    (automation ? automations : tasks).push(run);
  }
  return { automations, tasks };
}

function _homeLoad() {
  const seq = ++_homeLoadSeq;
  Promise.all([_homeLoadTodos(), _homeLoadRuns()])
    .then(([todos, runs]) => {
      if (seq !== _homeLoadSeq) return;
      _homeData = {
        todos: todos.tasks,
        todoTotal: todos.total,
        automations: runs.automations,
        tasks: runs.tasks,
      };
      _homeRender();
    })
    .catch((err) => {
      _homeLog.warn('home lookup failed', { error_type: _homeErrorType(err) });
      if (seq === _homeLoadSeq && _homeState === 'pending') _homeApplyState('empty');
    });
  return seq;
}

// ── Rendering ───────────────────────────────────────────────────────────

function _homeApplyState(state) {
  _homeState = state;
  const panel = document.getElementById('panel-new-chat');
  if (panel) panel.dataset.homeState = state;
}

function _homeLocale() {
  try {
    return getLocaleMeta(getLang()).intlLocale || undefined;
  } catch (_) {
    return undefined;
  }
}

/** "just now", "5 minutes ago", "yesterday", then a short date. */
function _homeRelativeTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return t('common.just_now');
  const locale = _homeLocale();
  try {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const minutes = Math.round(diff / 60000);
    if (minutes < 60) return relative.format(-minutes, 'minute');
    const hours = Math.round(diff / 3600000);
    if (hours < 24) return relative.format(-hours, 'hour');
    const days = Math.round(diff / 86400000);
    if (days < 7) return relative.format(-days, 'day');
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleDateString();
  }
}

function _homeProjectName(pid) {
  const projects = typeof _projectsCache !== 'undefined' && Array.isArray(_projectsCache) ? _projectsCache : [];
  const project = projects.find((item) => item && item.project_id === pid);
  return (project && project.name) || t('sidebar.projects');
}

function _homeTodoStatusLabel(status) {
  if (status === 'progress') return t('project.todo.status_progress');
  if (status === 'review') return t('project.todo.status_review');
  return t('project.todo.status_todo');
}

function _homeResultLabel(status) {
  if (status === 'completed') return t('new_chat.home.result.completed');
  if (status === 'failed') return t('new_chat.home.result.failed');
  if (status === 'waiting_input') return t('new_chat.home.result.waiting_input');
  if (status === 'stopped') return t('new_chat.home.result.stopped');
  return t('new_chat.home.result.unknown');
}

function _homeRunActionLabel(status) {
  if (status === 'waiting_input') return t('new_chat.home.action.reply');
  if (status === 'failed') return t('new_chat.home.action.view_reason');
  return t('new_chat.home.action.view_result');
}

// Run status glyphs. To-dos use the sidebar's To-do icon; the meta line
// repeats each row's status in words.
const _HOME_STATUS_ICONS = {
  todo: 'circle',
  progress: 'live',
  review: 'hourglass',
  completed: 'check-circle',
  failed: 'x-circle',
  waiting_input: 'message-circle-more',
  stopped: 'stop',
};

function _homeRowHtml({ attrs, status, icon, title, source, details, action }) {
  const attributes = Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeHtml(String(value))}"`)
    .join('');
  const meta = details.filter(Boolean).map((part) => escapeHtml(part)).join(' · ');
  const kind = Object.prototype.hasOwnProperty.call(_HOME_STATUS_ICONS, status) ? status : 'unknown';
  return `<button type="button" class="home-row"${attributes}>`
    + `<span class="home-row-status is-${kind}" aria-hidden="true">${_homeIcon(icon || _HOME_STATUS_ICONS[kind] || 'dot', 'home-row-status-icon')}</span>`
    + '<span class="home-row-main">'
    + `<span class="home-row-title">${escapeHtml(title)}</span>`
    + `<span class="home-row-meta"><span class="home-row-source">${escapeHtml(source)}</span>${meta}</span>`
    + '</span>'
    + `<span class="home-row-action">${escapeHtml(action)}${_homeIcon('chevron-right', 'home-row-action-icon')}</span>`
    + '</button>';
}

function _homeTodoRowHtml(task, index) {
  const pid = String(task.project_id || '');
  const status = String(task.status || 'todo');
  const content = String(task.content || '').split('\n').map((line) => line.trim()).find(Boolean);
  const updated = _homeRelativeTime(Date.parse(task.updated_at || task.created_at || ''));
  return _homeRowHtml({
    attrs: {
      'data-home-todo': task.id,
      'data-home-pid': pid,
      'data-home-status': status,
      'data-home-position': index + 1,
    },
    status,
    icon: 'clipboard-list',
    title: content || t('new_chat.home.untitled'),
    source: pid
      ? t('new_chat.home.source.project_todo', { project: task.project_name || _homeProjectName(pid) })
      : t('new_chat.home.source.global_todo'),
    details: [_homeTodoStatusLabel(status), _homeTodoDueLabel(task), updated ? t('new_chat.home.time.updated', { time: updated }) : ''],
    action: t('new_chat.home.action.view'),
  });
}

/** "Due Oct 25" or "Overdue since Oct 25" for a dated to-do; empty otherwise. */
function _homeTodoDueLabel(task) {
  const dueAt = typeof task.due_at === 'string' ? task.due_at : '';
  const parts = /^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? dueAt.split('-').map(Number) : null;
  if (!parts) return '';
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  let label = dueAt;
  try {
    label = new Intl.DateTimeFormat(_homeLocale(), {
      month: 'short', day: 'numeric', ...(parts[0] === now.getFullYear() ? {} : { year: 'numeric' }),
    }).format(date);
  } catch (_) { /* keep the stored text */ }
  return t(task.status !== 'done' && dueAt < today ? 'project.todo.due_overdue' : 'project.todo.due_on', { date: label });
}

function _homeRunRowHtml(run, section, index) {
  // Legacy unread records default to completed for presentation only.
  const displayStatus = ['completed', 'failed', 'waiting_input', 'stopped'].includes(run.status)
    ? run.status : 'completed';
  let source = t('new_chat.home.source.global_task');
  if (section === 'automations') source = t('new_chat.home.source.automation');
  else if (run.projectId) source = t('new_chat.home.source.project_task', { project: _homeProjectName(run.projectId) });
  return _homeRowHtml({
    attrs: {
      'data-home-cid': run.cid,
      'data-home-section': section,
      'data-home-status': run.status || 'unknown',
      'data-home-position': index + 1,
    },
    status: displayStatus,
    title: run.title || t('new_chat.home.untitled'),
    source,
    details: [_homeResultLabel(displayStatus), _homeRelativeTime(run.finishedAt)],
    action: _homeRunActionLabel(displayStatus),
  });
}

function _homeGroupTitle(section) {
  if (section === 'todos') return t('new_chat.home.group.todos');
  if (section === 'automations') return t('new_chat.home.group.automations');
  return t('new_chat.home.group.tasks');
}

function _homeSectionHtml(section) {
  const titleId = `home-group-${section}-title`;
  const isTodos = section === 'todos';
  const items = isTodos ? _homeData.todos : _homeData[section];
  const total = isTodos ? _homeData.todoTotal : items.length;
  const rowHtml = (item, index) => (isTodos ? _homeTodoRowHtml(item, index) : _homeRunRowHtml(item, section, index));
  // Group-level links sit in the group header: all automations, and the full
  // To-dos page when there are more to-dos than the rows shown here.
  let link = '';
  if (section === 'automations') {
    link = `<button type="button" class="home-text-btn" data-home-action="all_automations">${escapeHtml(t('new_chat.home.all_automations'))}</button>`;
  } else if (isTodos && total > _HOME_VISIBLE_ROWS) {
    link = `<button type="button" class="home-text-btn" data-home-action="more_todos" aria-describedby="${titleId}">${escapeHtml(t('new_chat.home.view_all_todos'))}</button>`;
  }
  let fold = '';
  let footer = '';
  if (items.length > _HOME_VISIBLE_ROWS) {
    const folded = items.slice(_HOME_VISIBLE_ROWS);
    const expanded = _homeExpanded.has(section);
    const foldId = `home-fold-${section}`;
    fold = `<div class="home-list-fold" id="${foldId}"${expanded ? '' : ' hidden'}>`
      + folded.map((item, index) => rowHtml(item, index + _HOME_VISIBLE_ROWS)).join('')
      + '</div>';
    footer = `<button type="button" class="home-text-btn home-group-more" data-home-toggle="${section}"`
      + ` data-home-folded="${folded.length}" aria-controls="${foldId}" aria-expanded="${expanded}">`
      + escapeHtml(expanded ? t('new_chat.home.collapse') : t('new_chat.home.expand', { count: folded.length }))
      + '</button>';
  }
  return `<section class="home-group" data-section="${section}" aria-labelledby="${titleId}">`
    + '<div class="home-group-head">'
    + `<h2 class="home-group-title" id="${titleId}">${escapeHtml(_homeGroupTitle(section))}<span class="home-group-count">${total}</span></h2>`
    + link
    + '</div>'
    + `<div class="home-list">${items.slice(0, _HOME_VISIBLE_ROWS).map(rowHtml).join('')}${fold}</div>`
    + footer
    + '</section>';
}

function _homeSectionCounts() {
  return {
    todos: _homeData.todoTotal,
    automations: _homeData.automations.length,
    tasks: _homeData.tasks.length,
  };
}

function _homeRender() {
  const counts = _homeSectionCounts();
  // Groups keep this order; one without items is left out entirely.
  const sections = ['todos', 'automations', 'tasks'].filter((section) => counts[section] > 0);
  const host = document.getElementById('home-groups');
  if (host) {
    // Background refreshes can arrive between focusing a control and pressing
    // Enter. Preserve its identity across replacement without moving the view.
    const active = document.activeElement;
    const focusKey = active && host.contains(active)
      ? ['homeToggle', 'homeAction', 'homeTodo', 'homeCid'].find(key => active.dataset[key])
      : null;
    const focusValue = focusKey ? active.dataset[focusKey] : '';
    const focusProject = focusKey ? active.dataset.homePid : undefined;
    host.innerHTML = sections.map(_homeSectionHtml).join('');
    if (focusKey) {
      const replacement = Array.from(host.querySelectorAll('button')).find(button =>
        button.dataset[focusKey] === focusValue && button.dataset.homePid === focusProject);
      replacement?.focus({ preventScroll: true });
    }
  }
  _homeApplyState(sections.length ? 'populated' : 'empty');
}

/** The empty state's "add materials or connect your services" line;
 *  the connect phrase is a button inside the translated sentence. */
function _homeRenderExploreContext() {
  const el = document.getElementById('home-explore-context');
  if (!el) return;
  const marker = '\u0001';
  const text = t('new_chat.home.explore_context', { connect: marker });
  const at = text.indexOf(marker);
  const link = `<button type="button" class="home-connect-link" data-home-connect="1">${escapeHtml(t('new_chat.home.explore_connect_link'))}</button>`;
  el.innerHTML = at < 0
    ? `${escapeHtml(text)} ${link}`
    : `${escapeHtml(text.slice(0, at))}${link}${escapeHtml(text.slice(at + marker.length))}`;
}

// ── Actions ─────────────────────────────────────────────────────────────

function _homeOpenRun(row) {
  const cid = row.dataset.homeCid || '';
  const section = row.dataset.homeSection === 'automations' ? 'automations' : 'tasks';
  // Opening it marks it read; drop it now so coming back never shows it.
  _homeData[section] = _homeData[section].filter((run) => run.cid !== cid);
  setView('conversation', cid, { entryPoint: 'home' });
}

async function _homeOpenTodo(row) {
  const pid = row.dataset.homePid || '';
  const id = row.dataset.homeTodo || '';
  // The To-dos page code loads with the page; load it first so the page can
  // open on this to-do.
  try {
    if (typeof loadRendererFeature === 'function') await loadRendererFeature('project');
  } catch (err) {
    _homeLog.warn('to-dos page unavailable from the home', { error_type: _homeErrorType(err) });
  }
  if (typeof focusTodo === 'function') focusTodo(pid, id, { entryPoint: 'home' });
  else setView('todos', null, { entryPoint: 'home' });
}

function _homeToggleFold(button) {
  const section = button.dataset.homeToggle;
  const fold = document.getElementById(`home-fold-${section}`);
  if (!fold) return;
  const expanded = fold.hidden;
  fold.hidden = !expanded;
  if (expanded) _homeExpanded.add(section);
  else _homeExpanded.delete(section);
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded
    ? t('new_chat.home.collapse')
    : t('new_chat.home.expand', { count: Number(button.dataset.homeFolded) || 0 });
}

function _homeOnGroupsClick(event) {
  const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
  if (!target) return;
  const toggle = target.closest('[data-home-toggle]');
  if (toggle) {
    _homeToggleFold(toggle);
    return;
  }
  const action = target.closest('[data-home-action]');
  if (action) {
    if (action.dataset.homeAction === 'more_todos') setView('todos', null, { entryPoint: 'home' });
    else if (action.dataset.homeAction === 'all_automations') setView('auto', null, { entryPoint: 'home' });
    return;
  }
  const row = target.closest('.home-row');
  if (!row) return;
  if (row.dataset.homeTodo) void _homeOpenTodo(row);
  else if (row.dataset.homeCid) _homeOpenRun(row);
}

// ── Lifecycle ───────────────────────────────────────────────────────────

function _homeBind() {
  if (_homeBound) return;
  _homeBound = true;
  document.getElementById('home-groups')?.addEventListener('click', _homeOnGroupsClick);
  document.getElementById('home-explore-context')?.addEventListener('click', (event) => {
    const link = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-home-connect]')
      : null;
    if (link) {
      setView('connectors', null, { entryPoint: 'home' });
    }
  });
  window.addEventListener('task-unread-change', homeRefresh);
  window.addEventListener('i18n-change', () => {
    _homeRenderExploreContext();
    if (_homeState === 'populated') _homeRender();
  });
  if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
    try { window.orkas.onPushEvent('projects:tasks-changed', homeRefresh); } catch (_) {}
  }
}

/** Called by `onEnterNewChatView` on every visit to the home. */
function homeOnEnter() {
  _homeBind();
  _homeExpanded.clear();
  clearTimeout(_homeRefreshTimer);
  _homeRefreshTimer = null;
  _homeRenderExploreContext();
  const seq = _homeLoad();
  if (_homeState === 'pending') {
    setTimeout(() => {
      if (seq === _homeLoadSeq && _homeState === 'pending') _homeApplyState('empty');
    }, _HOME_FIRST_PAINT_FALLBACK_MS);
  }
}

/** Re-read both lists while the home is showing; the next visit re-reads
 *  them anyway. */
function homeRefresh() {
  if (!_homeVisible()) return;
  clearTimeout(_homeRefreshTimer);
  _homeRefreshTimer = setTimeout(() => {
    _homeRefreshTimer = null;
    if (_homeVisible()) _homeLoad();
  }, _HOME_REFRESH_DEBOUNCE_MS);
}
