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
  // Commander chip visibility depends on cache size — hide entirely when
  // the user has zero projects (UX request: no project chip clutter on
  // first run / for users who don't adopt the feature).
  _renderCommanderProjectChip();
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
      <span class="project-icon">${ICON_FOLDER_CLOSED}</span>
      <input type="text" class="project-rename-input" id="project-create-input"
             placeholder="${placeholder}" autocomplete="off" spellcheck="false" />
    </div>
  `;
}

function _renderProjectRow(p, convs) {
  const expanded = !!_projectsExpanded[p.project_id];
  const editing = _projectsInlineRenamePid === p.project_id;
  // Reuse KB tree's folder SVG icons; open variant when expanded, closed
  // otherwise. Defined as global consts in modules/skills.js (script load
  // order: skills.js loads after projects.js, but renderProjectsSection
  // only runs post-DOMContentLoaded by which point all scripts have
  // initialised). No separate caret — the icon's open/closed state IS the
  // expand indicator (matches the KB tree pattern).
  const folderIcon = expanded ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
  const moreTitle = escapeHtml(t('project.menu.more_actions'));
  const safeName = escapeHtml(p.name || '');
  const nameNode = editing
    ? `<input type="text" class="project-rename-input" data-rename-pid="${escapeHtml(p.project_id)}"
              value="${escapeHtml(p.name || '')}" autocomplete="off" spellcheck="false" />`
    : `<span class="project-name" title="${safeName}">${safeName}</span>`;
  let html = `
    <div class="project-row" data-pid="${escapeHtml(p.project_id)}">
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
    } else {
      const delTitle = escapeHtml(t('chat.conv_del_title'));
      for (const c of convs) {
        const title = escapeHtml(c.title || t('chat.new_conv_title'));
        html += `
          <div class="conv-item conv-item-nested" data-cid="${c.conversation_id}">
            <div class="conv-item-title" title="${title}">${title}</div>
            <button class="conv-item-del" data-del-cid="${c.conversation_id}" title="${delTitle}">×</button>
          </div>
        `;
      }
    }
    html += '</div>';
  }
  return html;
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

  // Project rows: any click → BOTH open the detail page AND toggle the
  // expand state of nested conversations (per design — single click does
  // both). Exceptions: ⋯ opens its menu; rename input swallows click.
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
      _toggleProjectExpand(pid);
      if (typeof setView === 'function') setView('project', pid);
    });
  });

  // Nested conv items.
  container.querySelectorAll('.conv-item-nested').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.conv-item-del')) return;
      setView('conversation', el.dataset.cid);
    });
  });
  container.querySelectorAll('.conv-item-nested .conv-item-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cid = btn.dataset.delCid;
      if (!(await uiConfirm(t('chat.conv_del_confirm')))) return;
      if (typeof abortConvStream === 'function') abortConvStream(cid);
      if (typeof _forgetConvLocal === 'function') _forgetConvLocal(cid);
      await apiFetch(`/api/conversations/${cid}`, { method: 'DELETE' });
      if (currentCid === cid) setView('new-chat');
      await loadConversations();
      // Project conv counts changed → refresh project cache so future reads
      // (delete confirm body, etc.) see the right number.
      await loadProjects(true);
    });
  });
}

function _toggleProjectExpand(pid) {
  _projectsExpanded[pid] = !_projectsExpanded[pid];
  _saveProjectsExpanded();
  renderProjectsSection();
}

// ── Inline create ───────────────────────────────────────────────────────

function _startProjectInlineCreate() {
  if (_projectsInlineCreate) return;
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
  let committed = false;
  const commit = async (accept) => {
    if (committed) return;
    committed = true;
    const name = (input.value || '').trim();
    if (!accept || !name) {
      _cancelProjectInlineCreate();
      return;
    }
    try {
      const res = await window.orkas.invoke('projects.create', { name });
      if (!res || !res.ok) {
        // Re-enter editing mode + show inline error.
        committed = false;
        _showProjectInlineError(input, res && res.error);
        return;
      }
      // Auto-expand the freshly created project so users see it's empty &
      // ready for new convs.
      const pid = res.project && res.project.project_id;
      if (pid) {
        _projectsExpanded[pid] = true;
        _saveProjectsExpanded();
      }
      _projectsInlineCreate = false;
      await loadProjects(true);
    } catch (err) {
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
  // Clear inline error styling as the user types.
  input.addEventListener('input', () => _clearProjectInlineError(input));
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
  const pid = input.dataset.renamePid;
  const original = input.value;
  let committed = false;
  const commit = async (accept) => {
    if (committed) return;
    committed = true;
    const next = (input.value || '').trim();
    if (!accept || !next || next === original) {
      _cancelProjectInlineRename();
      return;
    }
    try {
      const res = await window.orkas.invoke('projects.rename', { projectId: pid, name: next });
      if (!res || !res.ok) {
        committed = false;
        _showProjectInlineError(input, res && res.error);
        return;
      }
      _projectsInlineRenamePid = null;
      await loadProjects(true);
    } catch (err) {
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
  input.addEventListener('input', () => _clearProjectInlineError(input));
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
    { action: 'new_conv', label: t('project.menu.new_conv') },
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
  if (action === 'new_conv') return _newConvWithProject(pid);
  if (action === 'rename') return _startProjectInlineRename(pid);
  if (action === 'delete') return _confirmDeleteProject(pid);
}

// Pin pid into the commander chip's localStorage key BEFORE switching view —
// onEnterCommanderProjectChip (fired from boot.js view-change) reads the same
// key and re-validates against _projectsCache, so by the time the new-chat
// panel mounts the chip is already showing this project.
function _newConvWithProject(pid) {
  try { localStorage.setItem(_COMMANDER_LAST_PROJECT_KEY, pid); } catch (_) {}
  setView('new-chat');
}

// ── Delete flow ─────────────────────────────────────────────────────────

async function _confirmDeleteProject(pid) {
  const project = (_projectsCache || []).find((p) => p.project_id === pid);
  if (!project) return;
  const name = project.name || '';
  const count = Number(project.conv_count || 0);
  // Build the confirm dialog. When N > 0 we surface the destructive scope on
  // the danger button itself so the user has to read N before clicking;
  // when N = 0 it's just a simple confirm.
  let message;
  let dangerLabel;
  if (count > 0) {
    message = t('project.delete_confirm_body', { count });
    dangerLabel = t('project.delete_danger_label', { count });
  } else {
    message = t('project.delete_confirm_body_empty', { name });
    dangerLabel = t('project.delete_danger_label_empty');
  }
  const ok = await uiConfirmDanger({
    title: t('project.delete_confirm_title', { name }),
    message,
    dangerLabel,
  });
  if (!ok) return;

  try {
    const res = await window.orkas.invoke('projects.delete', { projectId: pid });
    if (!res || !res.ok) {
      const code = res && res.error;
      if (code === 'has_running_conv') {
        await uiAlert(t('project.has_running_conv'));
      } else {
        await uiAlert(t('project.delete_failed_generic'));
      }
      return;
    }
    // Clear lastProject if the commander chip pointed at this pid.
    try {
      if (typeof _COMMANDER_LAST_PROJECT_KEY !== 'undefined') {
        const stored = localStorage.getItem(_COMMANDER_LAST_PROJECT_KEY);
        if (stored === pid) localStorage.removeItem(_COMMANDER_LAST_PROJECT_KEY);
      }
    } catch (_) {}
    // Drop expanded entry.
    if (_projectsExpanded[pid]) {
      delete _projectsExpanded[pid];
      _saveProjectsExpanded();
    }
    // The cascade dropped every conv in this project — if the active cid
    // was one of them, jump back to the new-chat view (mirrors the existing
    // single-conv delete behaviour).
    if (currentCid && Array.isArray(conversations)) {
      const stillExists = conversations.some((c) => c && c.conversation_id === currentCid && c.project_id !== pid);
      if (!stillExists) setView('new-chat');
    }
    await loadConversations();
    await loadProjects(true);
    // Commander chip may need to refresh ("None" if its pid was deleted).
    if (typeof refreshCommanderProjectChip === 'function') refreshCommanderProjectChip();
  } catch (err) {
    _projectsLog.error('delete project failed', err);
    await uiAlert(t('project.delete_failed_generic'));
  }
}

// ── Commander project chip ─────────────────────────────────────────────
// The commander tab (new-chat) carries a "Project: <name>" chip next to the
// recipient chip. Default is None; the last manual pick is remembered across
// sessions so reopening the commander tab restores the user's intent. The
// pick travels into the freshly-created conversation via
// `_pendingNewChatProjectId` (mirrors `_pendingNewChatRecipient`).
//
// In conversation detail there is NO project chip — project membership is
// frozen at create time per the design.

const _COMMANDER_LAST_PROJECT_KEY = 'commander.lastProject';
const _COMMANDER_NONE_SENTINEL = '__none__';

let _commanderProjectId = '';        // ephemeral, lives only while commander tab is mounted
let _pendingNewChatProjectId = '';   // ferried into the new conv after submit

/** Public: read the commander tab's currently-picked project id (or '' for
 *  None). user-workspace.js uses this to scope its chip on the new-chat panel. */
function getCommanderProjectId() {
  return _commanderProjectId || '';
}

/** Public: resolve a project id to its display name from the cache. Returns
 *  empty string when the pid is unknown (e.g. just deleted). Used by
 *  user-workspace.js for the chip tooltip. */
function getCommanderProjectIdName(pid) {
  if (!pid || !Array.isArray(_projectsCache)) return '';
  const p = _projectsCache.find((x) => x && x.project_id === pid);
  return (p && p.name) || '';
}

/** Public: surface the captured commander pick to handleNewChatSubmit so it
 *  can attach the projectId to the freshly-created conversation. The caller
 *  is expected to clear the ferry after consuming. */
function _captureCommanderProjectForNewChat() {
  _pendingNewChatProjectId = _commanderProjectId || '';
}

function _consumeCommanderProjectForNewChat() {
  const pid = _pendingNewChatProjectId;
  _pendingNewChatProjectId = '';
  return pid;
}

/** Public: re-render the commander chip label + reset to None when the
 *  pid is gone (project was deleted). Called from delete flow + boot. */
function refreshCommanderProjectChip() {
  // Bail when the pinned id has vanished from the cache → fall back to None.
  if (_commanderProjectId && Array.isArray(_projectsCache)) {
    const exists = _projectsCache.some((p) => p && p.project_id === _commanderProjectId);
    if (!exists) {
      _commanderProjectId = '';
      try { localStorage.removeItem(_COMMANDER_LAST_PROJECT_KEY); } catch (_) {}
    }
  }
  _renderCommanderProjectChip();
  // Workspace scope on the commander panel changes whenever the project pick
  // changes (or a pid silently fell back to None). Keep the chip in sync.
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
}

function _renderCommanderProjectChip() {
  const chip = document.getElementById('new-chat-project-chip');
  const nameEl = document.getElementById('new-chat-project-name');
  if (!chip || !nameEl) return;
  // Hide the chip entirely when the user has no projects yet — first-run
  // / non-adopters don't see a "Project: None" affordance until they
  // create at least one project. Re-shown automatically the moment a
  // project lands in the cache.
  const hasProjects = Array.isArray(_projectsCache) && _projectsCache.length > 0;
  if (!hasProjects) {
    chip.style.display = 'none';
    return;
  }
  chip.style.display = '';
  const pid = _commanderProjectId;
  if (pid) {
    const p = _projectsCache.find((x) => x && x.project_id === pid);
    if (p && p.name) {
      nameEl.textContent = p.name;
      nameEl.removeAttribute('data-i18n');
      return;
    }
  }
  // Fallback to None.
  nameEl.setAttribute('data-i18n', 'chat.project_none');
  nameEl.textContent = t('chat.project_none');
}

/** Restore the commander chip from localStorage on view-enter. Validates
 *  the saved pid still exists; falls back to None and clears storage if
 *  not. Called by conversation.js::onEnterNewChatView. */
function onEnterCommanderProjectChip() {
  let saved = '';
  try { saved = localStorage.getItem(_COMMANDER_LAST_PROJECT_KEY) || ''; } catch (_) {}
  if (saved === _COMMANDER_NONE_SENTINEL || !saved) {
    _commanderProjectId = '';
  } else if (Array.isArray(_projectsCache) && _projectsCache.some((p) => p && p.project_id === saved)) {
    _commanderProjectId = saved;
  } else {
    _commanderProjectId = '';
    try { localStorage.removeItem(_COMMANDER_LAST_PROJECT_KEY); } catch (_) {}
  }
  _renderCommanderProjectChip();
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
}

/** User clicked the commander chip → show a small popover listing
 *  None + every existing project. Reuses `.workspace-menu` (not
 *  `_aiSelectMount`) because this is a chip-row popover anchored next to
 *  the workspace chip — `_aiSelectMount` targets in-form dropdowns with
 *  different chrome (border / hover state / row height). */
function _showCommanderProjectPicker(anchor) {
  const old = document.getElementById('commander-project-picker');
  if (old) { old.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'commander-project-picker';
  menu.className = 'workspace-menu';
  anchor.classList.add('chat-project-chip--open');

  const items = [
    { id: '', name: t('chat.project_none') },
    ...((_projectsCache || []).map((p) => ({ id: p.project_id, name: p.name }))),
  ];
  for (const it of items) {
    const isActive = (it.id || '') === (_commanderProjectId || '');
    const row = document.createElement('div');
    row.className = 'workspace-menu-item' + (isActive ? ' workspace-menu-item--active' : '');
    const label = document.createElement('span');
    label.textContent = it.name;
    row.appendChild(label);
    if (isActive) {
      const check = document.createElement('span');
      check.className = 'workspace-menu-check';
      check.textContent = '✓';
      row.appendChild(check);
    }
    row.addEventListener('click', () => {
      _commanderProjectId = it.id || '';
      try {
        if (_commanderProjectId) localStorage.setItem(_COMMANDER_LAST_PROJECT_KEY, _commanderProjectId);
        else localStorage.setItem(_COMMANDER_LAST_PROJECT_KEY, _COMMANDER_NONE_SENTINEL);
      } catch (_) {}
      _renderCommanderProjectChip();
      if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
      // Recipient validation: switching to a project that doesn't include
      // the currently-picked agent must drop the chip back to commander
      // (otherwise the user sends @<unbound-agent> + commander has nothing
      // to dispatch to). No-op when commander or orphan project.
      if (typeof validateRecipientAgainstProject === 'function') {
        validateRecipientAgainstProject('new-chat', _commanderProjectId);
      }
      _closeMenu();
    });
    menu.appendChild(row);
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + 'px';
  menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';

  document.body.appendChild(menu);

  function _closeMenu() {
    menu.remove();
    anchor.classList.remove('chat-project-chip--open');
    document.removeEventListener('mousedown', _onOutside);
  }
  function _onOutside(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) _closeMenu();
  }
  setTimeout(() => document.addEventListener('mousedown', _onOutside), 0);
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
  // Commander chip click → open picker.
  const commanderChip = document.getElementById('new-chat-project-chip');
  if (commanderChip) {
    commanderChip.addEventListener('click', (e) => {
      e.stopPropagation();
      _showCommanderProjectPicker(commanderChip);
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
      _renderCommanderProjectChip();
    }
  });
});
