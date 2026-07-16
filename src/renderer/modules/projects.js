// ─── Sidebar Projects section ────────────────────────────────────────────
// Renders the "Projects" group above the conversation list. Each project
// row supports collapse/expand, a ⋯ menu (rename / delete), and inline
// rename. Conversations with a `project_id` field are nested under their
// project; conversations without `project_id` stay in the existing
// "Conversations" section (rendered by `conversation.js::renderConversationList`).
//
// Storage layout (cloud-synced): `<uid>/cloud/projects/<pid>/{project.json,
// bindings.json}` — no aggregate index, list = directory scan. See
// `features/projects.ts`. The renderer never persists projects state directly —
// every mutation goes through `projects.*` IPC channels.
//
// Depends on: ipc-shim.js (apiFetch), conversation.js (escapeHtml /
// renderConversationList / _refreshAllConvBadges), dialogs.js (uiConfirmDanger).

const _projectsLog = createLogger('projects');

function _projectsTrackClick(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _projectsTrackEvent(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _projectsTrackError(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _projectUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

// Live cache of projects fetched from the backend. Mirrors `_agentsCache` /
// `_skillsCache` patterns. `null` = not yet fetched.
let _projectsCache = null;

// Per-project expand/collapse state, persisted across sessions so the user's
// layout sticks. Default: collapsed.
const _PROJECTS_EXPANDED_KEY = 'sidebar.projectExpanded';
let _projectsExpanded = {};

function _loadProjectsExpanded() {
  try {
    const raw = localStorage.getItem(_PROJECTS_EXPANDED_KEY);
    if (raw) _projectsExpanded = JSON.parse(raw) || {};
  } catch (_) { _projectsExpanded = {}; }
}
function _saveProjectsExpanded() {
  try { localStorage.setItem(_PROJECTS_EXPANDED_KEY, JSON.stringify(_projectsExpanded)); } catch (_) {}
}
_loadProjectsExpanded();

// In-flight inline-create / inline-rename state. Only one editing row at a
// time across the whole sidebar.
let _projectsInlineCreate = false;
let _projectsInlineRenamePid = null;

// ── Public API: cache + render ──────────────────────────────────────────

async function loadProjects(forceRefresh) {
  if (_projectsCache && !forceRefresh) {
    renderProjectsSection();
    return _projectsCache;
  }
  try {
    const res = await window.orkas.invoke('projects.list', {});
    _projectsCache = (res && res.ok && Array.isArray(res.projects)) ? res.projects : [];
  } catch (err) {
    _projectsLog.warn('load projects failed', err);
    _projectsCache = [];
  }
  renderProjectsSection();
  return _projectsCache;
}

/** One-shot: ensure the project owning the active cid is expanded so the
 *  user can see their open conversation. **Does not run on every render**
 *  — that would defeat manual collapse. Call this from boot + setView
 *  ('conversation', cid) only. Manual user collapse always wins on the
 *  next render. */
function autoExpandActiveConvProject() {
  if (!currentCid || !Array.isArray(conversations)) return;
  const owner = conversations.find((c) => c && c.conversation_id === currentCid);
  const pid = owner && owner.project_id;
  if (!pid) return;
  if (_projectsExpanded[pid]) return;
  _projectsExpanded[pid] = true;
  _saveProjectsExpanded();
  renderProjectsSection();
}

/** Map cid → projectId from the live `conversations` global, used by
 *  `conversation.js::renderConversationList` to filter unprojected items
 *  and by us to group projected items by project. */
function _convsByProject() {
  const byPid = new Map();
  if (!Array.isArray(conversations)) return byPid;
  for (const c of conversations) {
    const pid = c && c.project_id;
    if (!pid) continue;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(c);
  }
  return byPid;
}

/** Project list at the top of the sidebar. Auto-expands the project that
 *  owns the active conversation so the live row is visible. */
function renderProjectsSection() {
  const container = document.getElementById('projects-list');
  if (!container) return;
  const projects = Array.isArray(_projectsCache) ? _projectsCache : [];
  if (!projects.length && !_projectsInlineCreate) {
    // No projects + not creating — render nothing (the `+` button at the
    // section header is the entry point). Avoid an empty-state row to keep
    // the sidebar compact when the user hasn't adopted the feature.
    container.innerHTML = '';
    return;
  }

  const byPid = _convsByProject();
  // **Auto-expand is intentionally NOT done here.** Earlier this lived
  // inline (force `_projectsExpanded[pid]=true` whenever currentCid belonged
  // to a project) and that meant clicking the row to collapse a project
  // whose conv was active immediately re-expanded on the very next render
  // — user perceived it as "can't collapse projects that have convs". Now
  // auto-expand is a one-shot side effect of explicit
  // `autoExpandActiveConvProject()` calls (boot + view-change to a
  // conversation), so manual collapse always wins.

  const rows = [];
  // Inline-create row at the top.
  if (_projectsInlineCreate) {
    rows.push(_renderInlineCreateRow());
  }
  for (const p of projects) {
    rows.push(_renderProjectRow(p, byPid.get(p.project_id) || []));
  }
  container.innerHTML = rows.join('');

  _bindProjectsHandlers(container);
  // Re-paint pending / queued badges on the conv items we just (re)rendered.
  if (typeof _refreshAllConvBadges === 'function') _refreshAllConvBadges();
}

function _renderInlineCreateRow() {
  const placeholder = escapeHtml(t('sidebar.project_create_placeholder'));
  // Match the same icon-only chrome as the regular project rows (no caret,
  // KB-style folder SVG) so the create row reads as "a project being born"
  // rather than a separate widget shape.
  return `
    <div class="project-row project-row-create" data-create>
      <span class="project-icon">${_projectUiIconHtml('folder', 'project-folder-icon')}</span>
      <input type="text" class="project-rename-input" id="project-create-input"
             placeholder="${placeholder}" autocomplete="off" spellcheck="false" />
    </div>
  `;
}

function _renderProjectRow(p, convs) {
  const expanded = !!_projectsExpanded[p.project_id];
  const selected = _isProjectSelected(p.project_id);
  const editing = _projectsInlineRenamePid === p.project_id;
  const folderIcon = expanded
    ? _projectUiIconHtml('folder-open', 'project-folder-icon')
    : _projectUiIconHtml('folder', 'project-folder-icon');
  const moreTitle = escapeHtml(t('project.menu.more_actions'));
  const safeName = escapeHtml(p.name || '');
  const nameNode = editing
    ? `<input type="text" class="project-rename-input" data-rename-pid="${escapeHtml(p.project_id)}"
              value="${escapeHtml(p.name || '')}" autocomplete="off" spellcheck="false" />`
    : `<span class="project-name" title="${safeName}">${safeName}</span>`;
  let html = `
    <div class="project-row${selected ? ' active' : ''}" data-pid="${escapeHtml(p.project_id)}">
      <span class="project-icon">${folderIcon}</span>
      ${nameNode}
      <button type="button" class="ctx-row-menu-btn project-row-menu-btn" data-project-menu
              data-pid="${escapeHtml(p.project_id)}"
              title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
    </div>
  `;
  if (expanded) {
    html += `<div class="project-conv-list" data-pid-children="${escapeHtml(p.project_id)}">`;
    if (!convs.length) {
      html += `<div class="project-conv-empty">${escapeHtml(t('sidebar.project_conv_empty'))}</div>`;
    } else if (typeof _renderConversationTimeBucketList === 'function') {
      html += _renderConversationTimeBucketList(convs, { nested: true, bucketScope: `project:${p.project_id}` });
    } else {
      for (const c of convs) {
        html += (typeof _renderConversationSidebarItem === 'function')
          ? _renderConversationSidebarItem(c, { nested: true })
          : `<div class="conv-item conv-item-nested" data-cid="${escapeHtml(c.conversation_id)}"><div class="conv-item-title" title="${escapeHtml(c.title || t('chat.new_conv_title'))}">${escapeHtml(c.title || t('chat.new_conv_title'))}</div></div>`;
      }
    }
    if (typeof _projectConversationHasMore === 'function' && _projectConversationHasMore(p.project_id)) {
      html += `<button type="button" class="conversation-list-load-more" data-project-conv-more="${escapeHtml(p.project_id)}">
        ${escapeHtml(t('sidebar.load_more_conversations'))}</button>`;
    }
    html += '</div>';
  }
  return html;
}

function _isProjectSelected(pid) {
  return currentView === 'project'
    && typeof _projectDetailPid !== 'undefined'
    && _projectDetailPid === pid;
}

/** Paint cached identity before the deferred project-detail script is parsed.
 * The panel markup is already eager, so first click can acknowledge the target
 * in the same frame instead of showing an anonymous blank surface. */
function primeProjectDetailShell(pid) {
  const project = Array.isArray(_projectsCache)
    ? _projectsCache.find((item) => item && item.project_id === pid)
    : null;
  const title = document.getElementById('project-detail-title');
  const content = document.getElementById('project-detail-content');
  if (title) title.textContent = project?.name || '';
  if (content) {
    content.classList.add('is-loading');
    content.setAttribute('aria-busy', 'true');
  }
}

// ── Event wiring ────────────────────────────────────────────────────────

function _bindProjectsHandlers(container) {
  // Inline-create input.
  const createInput = container.querySelector('#project-create-input');
  if (createInput) _bindInlineCreateInput(createInput);

  // Inline-rename inputs (at most one).
  container.querySelectorAll('input.project-rename-input[data-rename-pid]').forEach((input) => {
    _bindInlineRenameInput(input);
  });

  container.querySelectorAll('[data-project-conv-more]').forEach((button) => {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pid = button.dataset.projectConvMore || '';
      if (!pid || button.disabled) return;
      button.disabled = true;
      try { await loadConversationProject(pid, { append: true }); }
      catch (err) { _projectsLog.warn('load more project conversations failed', err); }
      finally { if (button.isConnected) button.disabled = false; }
    });
  });

  // Project rows: first click selects/opens the project detail. Once that
  // project is already selected, clicking the row toggles its nested
  // conversations.
  container.querySelectorAll('.project-row[data-pid]').forEach((row) => {
    const pid = row.dataset.pid;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.project-rename-input')) {
        e.stopPropagation();
        return;
      }
      if (e.target.closest('[data-project-menu]')) {
        e.stopPropagation();
        _openProjectRowMenu(e.target.closest('[data-project-menu]'), pid);
        return;
      }
      if (!_isProjectSelected(pid)) {
        _projectsTrackClick('project_open', { project_id: pid });
        if (typeof setView === 'function') setView('project', pid);
        renderProjectsSection();
        return;
      }
      _toggleProjectExpand(pid);
    });
  });

  if (typeof _bindConversationSidebarItems === 'function') {
    _bindConversationSidebarItems(container, {
      selector: '.conv-item-nested',
      onBucketToggle: renderProjectsSection,
      async afterDelete() {
        // Project conv counts changed → refresh project cache so future reads
        // (delete confirm body, etc.) see the right number.
        await loadProjects(true);
      },
    });
  } else {
    // Nested conv items.
    container.querySelectorAll('.conv-item-nested').forEach((el) => {
      el.addEventListener('click', () => setView('conversation', el.dataset.cid));
    });
  }
}

async function _toggleProjectExpand(pid) {
  const expanding = !_projectsExpanded[pid];
  _projectsExpanded[pid] = expanding;
  _projectsTrackClick('project_expand_toggle', {
    project_id: pid,
    expanded: !!_projectsExpanded[pid],
  });
  _saveProjectsExpanded();
  if (expanding && typeof loadConversationProject === 'function') {
    try {
      await loadConversationProject(pid);
    } catch (err) {
      _projectsLog.warn('load project conversations failed', err);
    }
  }
  renderProjectsSection();
}

// ── Inline create ───────────────────────────────────────────────────────

function _startProjectInlineCreate() {
  if (_projectsInlineCreate) return;
  _projectsTrackClick('project_create_open', {});
  _projectsInlineRenamePid = null;
  _projectsInlineCreate = true;
  renderProjectsSection();
  setTimeout(() => {
    const input = document.getElementById('project-create-input');
    if (input) input.focus();
  }, 0);
}

function _cancelProjectInlineCreate() {
  if (!_projectsInlineCreate) return;
  _projectsInlineCreate = false;
  renderProjectsSection();
}

function _bindInlineCreateInput(input) {
  input.addEventListener('click', (e) => e.stopPropagation());
  if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(input);
  let committed = false;
  const commit = async (accept) => {
    if (committed) return;
    committed = true;
    const name = _normaliseProjectNameFinal(input.value);
    if (!accept || !name) {
      _cancelProjectInlineCreate();
      return;
    }
    const startedAt = performance.now();
    _projectsTrackClick('project_create_submit', { name_length: name.length });
    try {
      const res = await window.orkas.invoke('projects.create', { name });
      if (!res || !res.ok) {
        _projectsTrackEvent('project_create_result', {
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        // Re-enter editing mode + show inline error.
        committed = false;
        _showProjectInlineError(input, res && res.error);
        return;
      }
      // Auto-expand the freshly created project so users see it's empty &
      // ready for new convs.
      const pid = res.project && res.project.project_id;
      _projectsTrackEvent('project_create_result', {
        result: 'success',
        project_id: pid || '',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      if (pid) {
        _projectsExpanded[pid] = true;
        _saveProjectsExpanded();
      }
      _projectsInlineCreate = false;
      await loadProjects(true);
    } catch (err) {
      _projectsTrackEvent('project_create_result', {
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _projectsTrackError('project_create', {
        error_type: 'exception',
      });
      committed = false;
      _showProjectInlineError(input, err && err.message);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('input', () => {
    _clearProjectInlineError(input);
  });
}

// ── Inline rename ───────────────────────────────────────────────────────

function _startProjectInlineRename(pid) {
  _projectsInlineCreate = false;
  _projectsInlineRenamePid = pid;
  renderProjectsSection();
  setTimeout(() => {
    const input = document.querySelector(`input.project-rename-input[data-rename-pid="${CSS.escape(pid)}"]`);
    if (input) {
      input.focus();
      input.select();
    }
  }, 0);
}

function _cancelProjectInlineRename() {
  if (!_projectsInlineRenamePid) return;
  _projectsInlineRenamePid = null;
  renderProjectsSection();
}

function _bindInlineRenameInput(input) {
  input.addEventListener('click', (e) => e.stopPropagation());
  if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(input);
  const pid = input.dataset.renamePid;
  const original = input.value;
  let committed = false;
  const commit = async (accept) => {
    if (committed) return;
    committed = true;
    const next = _normaliseProjectNameFinal(input.value);
    if (!accept || !next || next === original) {
      _cancelProjectInlineRename();
      return;
    }
    const startedAt = performance.now();
    _projectsTrackClick('project_rename_submit', {
      project_id: pid,
      name_length: next.length,
    });
    try {
      const res = await window.orkas.invoke('projects.rename', { projectId: pid, name: next });
      if (!res || !res.ok) {
        _projectsTrackEvent('project_rename_result', {
          project_id: pid,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        committed = false;
        _showProjectInlineError(input, res && res.error);
        return;
      }
      _projectsTrackEvent('project_rename_result', {
        project_id: pid,
        result: 'success',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _projectsInlineRenamePid = null;
      await loadProjects(true);
    } catch (err) {
      _projectsTrackEvent('project_rename_result', {
        project_id: pid,
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _projectsTrackError('project_rename', {
        project_id: pid,
        error_type: 'exception',
      });
      committed = false;
      _showProjectInlineError(input, err && err.message);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('input', () => {
    _clearProjectInlineError(input);
  });
}

function _normaliseProjectNameFinal(raw) {
  let name = String(raw || '').trim();
  if (typeof window.limitNameDisplayText === 'function') name = window.limitNameDisplayText(name);
  return name;
}

function _showProjectInlineError(input, code) {
  if (!input) return;
  input.classList.add('is-error');
  // Build / replace a sibling hint right below the input.
  let hint = input.parentElement?.querySelector('.project-inline-error');
  if (!hint) {
    hint = document.createElement('div');
    hint.className = 'project-inline-error';
    input.parentElement?.appendChild(hint);
  }
  let key = 'project.error.generic';
  if (code === 'name_dup') key = 'project.name_dup_inline';
  else if (code === 'name_empty') key = 'project.name_empty';
  hint.textContent = t(key);
  // Re-focus so the user can keep editing without an extra click.
  setTimeout(() => input.focus(), 0);
}

function _clearProjectInlineError(input) {
  if (!input) return;
  input.classList.remove('is-error');
  const hint = input.parentElement?.querySelector('.project-inline-error');
  if (hint) hint.remove();
}

// ── ⋯ menu ──────────────────────────────────────────────────────────────

function _openProjectRowMenu(anchorBtn, pid) {
  let menu = document.getElementById('project-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-row-menu';
    menu.className = 'ctx-row-menu';  // reuse KB menu styling
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.pid === pid && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectRowMenu(); return; }
  _closeProjectRowMenu();

  const items = [
    { action: 'rename', label: t('project.menu.rename') },
    { action: 'delete', label: t('project.menu.delete'), danger: true },
  ];
  menu.innerHTML = items.map((it) =>
    `<div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.dataset.pid = pid;

  const srcRow = anchorBtn.closest('.project-row');
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
  if (srcRow) srcRow.classList.add('is-menu-open');

  // Position above-or-below, mirroring KB.
  menu.style.display = 'block';
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  const rect = anchorBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectRowMenu();
      await _runProjectMenuAction(action, pid);
    });
  }
}

function _closeProjectRowMenu() {
  const menu = document.getElementById('project-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.pid;
  }
  for (const r of document.querySelectorAll('.project-row.is-menu-open')) r.classList.remove('is-menu-open');
}

async function _runProjectMenuAction(action, pid) {
  if (action === 'rename') return _startProjectInlineRename(pid);
  if (action === 'delete') return _confirmDeleteProject(pid);
}

// ── Delete flow ─────────────────────────────────────────────────────────

function _pickProjectDeleteFallback(deletedPid, projectsBeforeDelete, projectsAfterDelete, conversationsAfterDelete) {
  const projects = Array.isArray(projectsAfterDelete)
    ? projectsAfterDelete.filter((p) => p && p.project_id && p.project_id !== deletedPid)
    : [];
  if (projects.length) {
    const before = Array.isArray(projectsBeforeDelete)
      ? projectsBeforeDelete.filter((p) => p && p.project_id)
      : [];
    const projectIds = new Set(projects.map((p) => p.project_id));
    const deletedIdx = before.findIndex((p) => p.project_id === deletedPid);
    if (deletedIdx >= 0) {
      for (let i = deletedIdx + 1; i < before.length; i += 1) {
        const nextId = before[i]?.project_id;
        if (nextId && projectIds.has(nextId)) return { view: 'project', id: nextId };
      }
      for (let i = deletedIdx - 1; i >= 0; i -= 1) {
        const prevId = before[i]?.project_id;
        if (prevId && projectIds.has(prevId)) return { view: 'project', id: prevId };
      }
    }
    return { view: 'project', id: projects[0].project_id };
  }

  const conv = Array.isArray(conversationsAfterDelete)
    ? conversationsAfterDelete.find((c) => c && c.conversation_id && c.project_id !== deletedPid)
    : null;
  if (conv) return { view: 'conversation', id: conv.conversation_id };
  return { view: 'new-chat', id: '' };
}

function _goToProjectDeleteFallback(target) {
  if (!target || typeof setView !== 'function') return;
  const opts = { entryPoint: 'project_delete_fallback' };
  if (target.view === 'project' && target.id) setView('project', target.id, opts);
  else if (target.view === 'conversation' && target.id) setView('conversation', target.id, opts);
  else setView('new-chat', null, opts);
}

async function _confirmDeleteProject(pid) {
  const project = (_projectsCache || []).find((p) => p.project_id === pid);
  if (!project) return;
  const name = project.name || '';
  const count = Number(project.conv_count || 0);
  const projectsBeforeDelete = Array.isArray(_projectsCache) ? _projectsCache.slice() : [];
  const wasViewingDeletedProject = currentView === 'project'
    && typeof _projectDetailPid !== 'undefined'
    && _projectDetailPid === pid;
  const activeConversationWasDeleted = !!currentCid
    && Array.isArray(conversations)
    && conversations.some((c) => c && c.conversation_id === currentCid && c.project_id === pid);
  // Look up project-scoped auto tasks BEFORE confirm so the body can warn
  // the user they'll be cascade-deleted too. Best-effort: a transient IPC
  // failure falls through to the no-auto-tasks message; the backend's
  // cascade in `projects.deleteProject` still cleans them up either way.
  let autoCount = 0;
  try {
    const r = await window.orkas.invoke('autoTasks.list', { projectId: pid });
    if (r && Array.isArray(r.tasks)) autoCount = r.tasks.length;
  } catch (_) { /* ignore — fall through with autoCount = 0 */ }
  // Build the confirm dialog. When N > 0 we surface the destructive scope on
  // the danger button itself so the user has to read N before clicking;
  // when N = 0 it's just a simple confirm. Auto-task suffix appended
  // whenever the project owns at least one task.
  let message;
  let dangerLabel;
  if (count > 0) {
    message = t('project.delete_confirm_body', { count });
    dangerLabel = t('project.delete_danger_label', { count });
  } else {
    message = t('project.delete_confirm_body_empty', { name });
    dangerLabel = t('project.delete_danger_label_empty');
  }
  if (autoCount > 0) {
    message += ' ' + t('project.delete_confirm_auto_suffix', { n: autoCount });
  }
  const ok = await uiConfirmDanger({
    title: t('project.delete_confirm_title', { name }),
    message,
    dangerLabel,
  });
  if (!ok) return;

  const startedAt = performance.now();
  _projectsTrackClick('project_delete', {
    project_id: pid,
    conversation_count: count,
    auto_count: autoCount,
  });
  try {
    const res = await window.orkas.invoke('projects.delete', { projectId: pid });
    if (!res || !res.ok) {
      _projectsTrackEvent('project_delete_result', {
        project_id: pid,
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      const code = res && res.error;
      if (code === 'has_running_conv') {
        await uiAlert(t('project.has_running_conv'));
      } else if (code === 'recycle_archive_failed' || res?.code === 'recycle_archive_failed') {
        await uiAlert(t('project.delete_archive_failed'));
      } else {
        await uiAlert(t('project.delete_failed_generic'));
      }
      return;
    }
    _projectsTrackEvent('project_delete_result', {
      project_id: pid,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    // Drop expanded entry.
    if (_projectsExpanded[pid]) {
      delete _projectsExpanded[pid];
      _saveProjectsExpanded();
    }
    await loadConversations();
    const projectsAfterDelete = await loadProjects(true);
    if (typeof window.refreshAutoProjectOptions === 'function') {
      try { window.refreshAutoProjectOptions(pid); } catch (_) { /* auto dialog may be unmounted */ }
    }
    if (wasViewingDeletedProject || activeConversationWasDeleted) {
      _goToProjectDeleteFallback(_pickProjectDeleteFallback(
        pid,
        projectsBeforeDelete,
        projectsAfterDelete,
        conversations,
      ));
    }
  } catch (err) {
    _projectsTrackEvent('project_delete_result', {
      project_id: pid,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectsTrackError('project_delete', {
      project_id: pid,
      error_type: 'exception',
    });
    _projectsLog.error('delete project failed', err);
    await uiAlert(t('project.delete_failed_generic'));
  }
}

// ── Project name resolver ──────────────────────────────────────────────
// Empty-state composer no longer carries a project chip — new conversations
// from the commander tab are always orphan. Project membership is bound
// only via the per-project page. This resolver is kept because the
// conversation header + workspace chip tooltip still need a pid → name
// lookup for already-bound conversations.

/** Resolve a project id to its display name from the cache. Returns empty
 *  string when the pid is unknown (e.g. just deleted). */
function getCommanderProjectIdName(pid) {
  if (!pid || !Array.isArray(_projectsCache)) return '';
  const p = _projectsCache.find((x) => x && x.project_id === pid);
  return (p && p.name) || '';
}

// ── Init ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // `+` button on the section header.
  const addBtn = document.getElementById('projects-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _startProjectInlineCreate();
    });
  }
  // Outside-click closes the ⋯ menu (mirrors KB).
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('project-row-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('[data-project-menu]')) return;
    _closeProjectRowMenu();
  });
  window.addEventListener('scroll', _closeProjectRowMenu, true);
  window.addEventListener('resize', _closeProjectRowMenu);
  window.addEventListener('i18n-change', () => {
    _closeProjectRowMenu();
    if (_projectsCache) {
      renderProjectsSection();
    }
  });
});

if (typeof window !== 'undefined') window.primeProjectDetailShell = primeProjectDetailShell;
