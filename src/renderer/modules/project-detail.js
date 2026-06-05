// ─── Project detail panel ───────────────────────────────────────────────
// Drives `#panel-project`: shows the project composer, task panes, and a
// right-side rail for project agents + files.
//
// Header carries Rename / Delete. The "Back" button was intentionally
// removed — the sidebar IS the back navigation.
//
// Add picker and project-file viewer are centered modals (`.modal-overlay`)
// so they don't get clipped by the project panel's scrolling regions.

const _projectDetailLog = createLogger('project-detail');

let _projectDetailPid = '';     // pid currently rendered in the panel
let _projectDetailMeta = null;  // { project, agentDetails, skillDetails, files, libraryStatus? }
let _projectKbStatusByName = {}; // {[name]: {status, chunks?, error?, kind?}}
let _projectKbEventsHandle = null;
let _projectKbEventsPid = '';
let _projectLibraryActiveName = '';
let _projectLibraryMveController = null;
const _projectLibraryExpanded = new Set();
const _projectLibraryDrafts = new Map();
let _projectKbStatusRefreshTimer = null;
let _projectKbReconcileInFlight = false;

// ── Public: navigate-into ──────────────────────────────────────────────

/** Called by boot.js setView('project', pid) on entry. */
async function loadProjectDetail(pid) {
  const prevPid = _projectDetailPid;
  if (prevPid && prevPid !== pid) {
    _projectLibraryDrafts.clear();
    _projectLibraryExpanded.clear();
    _clearProjectLibraryViewer();
  }
  _projectDetailPid = pid || '';
  if (!_projectDetailPid) {
    _renderProjectDetailEmpty();
    return;
  }
  if (_projectKbEventsPid && _projectKbEventsPid !== _projectDetailPid) {
    _stopProjectKbEventSubscription();
  }
  try {
    const [getRes, listRes, filesRes, kbRes] = await Promise.all([
      window.orkas.invoke('projects.get', { projectId: pid }),
      window.orkas.invoke('projects.bindings.list', { projectId: pid }),
      window.orkas.invoke('projects.files.tree', { projectId: pid }),
      window.orkas.invoke('projects.files.status', { projectId: pid, skipReconcile: true }).catch((err) => ({ ok: false, error: err?.message || String(err) })),
    ]);
    if (!getRes?.ok || !listRes?.ok || !filesRes?.ok) {
      throw new Error((getRes && getRes.error) || (listRes && listRes.error) || (filesRes && filesRes.error) || 'load_failed');
    }
    const fileTree = Array.isArray(filesRes.tree) ? filesRes.tree : [];
    const flatFiles = _flattenProjectLibraryFiles(fileTree);
    _projectKbStatusByName = _buildProjectKbStatusMap(flatFiles, kbRes?.ok ? (kbRes.files || []) : []);
    _projectDetailMeta = {
      project: getRes.project,
      agentDetails: Array.isArray(listRes.agentDetails) ? listRes.agentDetails : [],
      skillDetails: Array.isArray(listRes.skillDetails) ? listRes.skillDetails : [],
      files: fileTree,
      libraryStatus: kbRes?.ok ? kbRes : null,
    };
    _renderProjectDetail();
    _kickProjectKbReconcileIfNeeded();
    _scheduleProjectKbStatusRefreshIfNeeded();
  } catch (err) {
    _projectDetailLog.warn('load project detail failed', err);
    if (typeof setView === 'function') setView('new-chat');
    if (typeof uiAlert === 'function') uiAlert(t('project.detail_load_failed'));
  }
}

function _renderProjectDetailEmpty() {
  _projectKbStatusByName = {};
  _stopProjectKbEventSubscription();
  _setProjectDetailRenameMode(false);
  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = '';
  const headerCountEl = document.getElementById('project-detail-header-count');
  if (headerCountEl) headerCountEl.textContent = '';
  const agents = document.getElementById('project-agents-list');
  const files = document.getElementById('project-files-list');
  const agentsEmpty = document.getElementById('project-agents-empty');
  if (agents) agents.innerHTML = '';
  if (files) files.innerHTML = '';
  if (agentsEmpty) agentsEmpty.style.display = '';
  _clearProjectLibraryViewer();
  _setCardCount('project-detail-agents-count', 0);
  _setCardCount('project-detail-files-count', 0);
}

function _renderProjectDetail() {
  if (!_projectDetailMeta) { _renderProjectDetailEmpty(); return; }
  const { project, agentDetails, files } = _projectDetailMeta;

  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = project?.name || '';

  // Page-header count chip: number of conversations bound to this project.
  // `conv_count` is set by `features/projects.ts::listProjects` (sidebar path)
  // but not by the single-project `getProject` we just called; fall back to a
  // live count from the conversations global so the chip is correct either way.
  const headerCountEl = document.getElementById('project-detail-header-count');
  if (headerCountEl) {
    let n = Number(project?.conv_count);
    if (!Number.isFinite(n) || n < 0) {
      n = (Array.isArray(typeof conversations !== 'undefined' ? conversations : null))
        ? conversations.filter((c) => c && c.project_id === _projectDetailPid).length
        : 0;
    }
    headerCountEl.textContent = n > 0 ? String(n) : '';
  }

  const agentsList = document.getElementById('project-agents-list');
  const hasAgents = (agentDetails || []).length > 0;
  if (agentsList) {
    agentsList.innerHTML = _renderProjectAgentCards(agentDetails || []);
    agentsList.style.display = hasAgents ? '' : 'none';
  }
  const agentsEmpty = document.getElementById('project-agents-empty');
  if (agentsEmpty) agentsEmpty.style.display = hasAgents ? 'none' : '';
  _renderProjectFiles(files || []);
  _renderProjectAllTasks();
  _bindProjectDetailTabs();
  _bindProjectAutoAddBtn();

  // Per-card count chips beside each card title.
  _setCardCount('project-detail-agents-count', (agentDetails || []).length);
  _setCardCount('project-detail-files-count', _flattenProjectLibraryFiles(files || []).length);

  applyDomI18n();
  _setProjectDetailRenameMode(_isProjectDetailRenameMode());
  _bindProjectAgentCards();
  _bindRemoveButtons();
  _bindProjectFileRows();
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
  if (typeof hydrateUiIcons === 'function') hydrateUiIcons(document.getElementById('project-detail-content'));
  _ensureProjectKbEventSubscription(_projectDetailPid);
  // Project-scoped auto tasks (rendered into the 自动化 tab pane).
  if (typeof loadProjectAutoList === 'function') {
    loadProjectAutoList(_projectDetailPid).catch(() => { /* ignore */ });
  }
}

/** Tab nav binding: switch panel visibility + remember the active tab. */
let _projectDetailActiveTab = 'tasks';
function _bindProjectDetailTabs() {
  const tabs = document.querySelectorAll('.project-detail-tab');
  if (!tabs.length) return;
  const available = new Set(Array.from(tabs).map((tab) => tab.dataset.projectTab || 'tasks'));
  if (!available.has(_projectDetailActiveTab)) _projectDetailActiveTab = 'tasks';
  for (const tab of tabs) {
    if (tab.dataset.bound !== '1') {
      tab.dataset.bound = '1';
      tab.addEventListener('click', () => {
        _projectDetailActiveTab = tab.dataset.projectTab || 'tasks';
        _syncProjectDetailTabState();
      });
    }
  }
  _syncProjectDetailTabState();
}

function _syncProjectDetailTabState() {
  const tabs = document.querySelectorAll('.project-detail-tab');
  const panels = document.querySelectorAll('.project-detail-tab-panel');
  for (const tab of tabs) {
    tab.classList.toggle('is-active', (tab.dataset.projectTab || 'tasks') === _projectDetailActiveTab);
  }
  for (const panel of panels) {
    panel.hidden = (panel.dataset.projectPanel !== _projectDetailActiveTab);
  }
}

/** Bind the "+ 新建任务" button in the project's automation tab. Opens the
 *  shared auto-task modal with this project pre-bound (locked mode). */
function _bindProjectAutoAddBtn() {
  const btn = document.getElementById('project-auto-add-btn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    if (!_projectDetailPid || typeof openAutoTaskDialog !== 'function') return;
    openAutoTaskDialog({
      projectId: _projectDetailPid,
      onSaved: () => {
        if (typeof loadProjectAutoList === 'function') loadProjectAutoList(_projectDetailPid).catch(() => {});
      },
    });
  });
}

/** "All tasks" tab pane: full list of conversations belonging to this
 *  project. Replaces the earlier capped "recent conversations" section
 *  (no view-all button — this IS the full list). */
function _renderProjectAllTasks() {
  const listEl = document.getElementById('project-tasks-list');
  const emptyEl = document.getElementById('project-tasks-empty');
  const countEl = document.getElementById('project-tasks-count');
  if (!listEl) return;
  const hasRenderer = typeof _renderConversationSidebarItem === 'function'
    && typeof conversations !== 'undefined'
    && Array.isArray(conversations);
  if (!_projectDetailPid || !hasRenderer) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    if (countEl) countEl.textContent = '';
    return;
  }
  const convs = conversations.filter((c) => c && c.project_id === _projectDetailPid);
  if (countEl) countEl.textContent = convs.length > 0 ? String(convs.length) : '';
  if (!convs.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  listEl.innerHTML = (typeof _renderConversationTimeBucketList === 'function')
    ? _renderConversationTimeBucketList(convs, { nested: true, bucketScope: `project-detail:${_projectDetailPid}` })
    : convs
        .slice()
        .sort((a, b) => {
          const ta = a.last_active_at || a.updated_at || a.created_at || '';
          const tb = b.last_active_at || b.updated_at || b.created_at || '';
          return tb.localeCompare(ta);
        })
        .map((c) => _renderConversationSidebarItem(c, { nested: true }))
        .join('');
  if (typeof _bindConversationSidebarItems === 'function') {
    _bindConversationSidebarItems(listEl, {
      selector: '.conv-item',
      onBucketToggle: _renderProjectAllTasks,
      async afterDelete() {
        if (typeof loadProjects === 'function') await loadProjects(true);
      },
    });
  }
  if (typeof _refreshAllConvBadges === 'function') _refreshAllConvBadges();
}

function _setCardCount(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = Number(n) > 0 ? String(n) : '';
}

function _renderProjectAgentCards(items) {
  const sorted = (items || []).slice().sort(_byDisplayName);
  if (!sorted.length) return '';
  const useTitle = escapeHtml(t('agents.use_tooltip'));
  const removeTitle = escapeHtml(t('project.bindings.remove'));
  return sorted.map((a) => {
    const id = a.agent_id || a.id || '';
    const enabled = a.enabled !== false;
    const avatarHtml = (typeof renderAvatarHtml === 'function')
      ? renderAvatarHtml(a.icon, a.color, {
        size: 28, seed: id, extraClass: 'project-agent-row-avatar',
      })
      : '';
    return `
      <div class="project-agent-row${enabled ? '' : ' is-disabled'}" role="button" tabindex="0"
           data-project-agent-id="${escapeHtml(id)}" data-source="${escapeHtml(a.source || '')}">
        ${avatarHtml}
        <span class="project-agent-row-name">${escapeHtml(a.name || t('agents.unnamed'))}</span>
        <div class="project-agent-row-actions">
          <button type="button" class="project-agent-row-run agent-card-use" data-project-agent-run title="${useTitle}" aria-label="${useTitle}">
            ${typeof _agentUiIconHtml === 'function' ? _agentUiIconHtml('play-triangle', 'icon-play') : ''}
          </button>
          <button type="button" class="project-agent-row-remove" data-project-agent-remove title="${removeTitle}" aria-label="${removeTitle}">
            ${_projectUiIconHtml('x', 'project-agent-remove-icon') || '×'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function _bindProjectAgentCards() {
  const root = document.getElementById('project-agents-list');
  if (!root) return;
  root.querySelectorAll('.project-agent-row[data-project-agent-id]').forEach((card) => {
    const id = card.dataset.projectAgentId || '';
    card.addEventListener('click', async () => {
      await _openProjectAgentDetail(id);
    });
    card.addEventListener('keydown', async (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.target?.closest?.('button')) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      await _openProjectAgentDetail(id);
    });
    card.querySelector('[data-project-agent-run]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _runProjectAgent(id);
    });
    card.querySelector('[data-project-agent-remove]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _removeProjectAgent(id);
    });
  });
}

async function _openProjectAgentDetail(agentId) {
  if (!agentId) return;
  try {
    if (typeof setView === 'function') setView('agents');
    if (typeof _showAgentsDetailView === 'function') {
      await _showAgentsDetailView(agentId);
    } else if (typeof selectAgent === 'function') {
      await selectAgent(agentId);
    }
  } catch (err) {
    _projectDetailLog.warn('open project agent detail failed', err);
  }
}

async function _runProjectAgent(agentId) {
  if (!_projectDetailPid || !agentId) return;
  if (typeof ensureModelConfigured === 'function' && !ensureModelConfigured()) return;
  try {
    const aRes = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
    const aData = await aRes.json();
    if (!aData.ok || !aData.agent) throw new Error(aData.error || t('agents.agent_not_found'));
    const agent = aData.agent;
    const visible = t('agents.run_prefix', { name: agent.name || agent.agent_id });
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'normal', projectId: _projectDetailPid }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('agents.create_conv_failed'));
    const conv = data.conversation;
    conv.project_id = conv.project_id || _projectDetailPid;
    conv.title = (typeof _autoTitle === 'function') ? _autoTitle(visible) : visible.slice(0, 32);
    conv.last_active_at = new Date().toISOString();
    conversations.unshift(conv);
    renderConversationList();
    if (typeof loadProjects === 'function') loadProjects(true);
    if (typeof setView === 'function') setView('conversation', conv.conversation_id, { skipLoad: true });
    if (typeof setChatRecipient === 'function') {
      setChatRecipient('conversation', {
        kind: 'agent',
        id: agentId,
        name: agent.name || agent.agent_id,
      });
    }
    setTimeout(() => {
      if (typeof sendInCurrentConversation === 'function') sendInCurrentConversation(visible);
    }, 50);
  } catch (e) {
    if (typeof uiAlert === 'function') await uiAlert(t('agents.launch_failed', { reason: e.message || e }));
  }
}

function _openProjectAgentMenu(anchorBtn, agentId) {
  let menu = document.getElementById('project-agent-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-agent-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.agentId === agentId && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectAgentMenu(); return; }
  _closeProjectAgentMenu();
  menu.innerHTML = `<div class="ctx-row-menu-item is-danger" data-action="remove">${escapeHtml(t('project.bindings.remove'))}</div>`;
  menu.dataset.agentId = agentId;
  const card = anchorBtn.closest('.agent-card');
  if (card) card.classList.add('is-menu-open');
  _positionProjectFileMenu(menu, anchorBtn);
  menu.querySelector('[data-action="remove"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    _closeProjectAgentMenu();
    await _removeProjectAgent(agentId);
  });
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectAgentMenuOutside, true);
    document.addEventListener('keydown', _onProjectAgentMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectAgentMenu, { once: true });
  }, 0);
}

function _closeProjectAgentMenu() {
  const menu = document.getElementById('project-agent-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.agentId;
  }
  document.querySelectorAll('#project-agents-list .agent-card.is-menu-open')
    .forEach((card) => card.classList.remove('is-menu-open'));
  document.removeEventListener('mousedown', _onProjectAgentMenuOutside, true);
  document.removeEventListener('keydown', _onProjectAgentMenuKeyDown, true);
  window.removeEventListener('resize', _closeProjectAgentMenu);
}

function _onProjectAgentMenuOutside(ev) {
  const menu = document.getElementById('project-agent-row-menu');
  if (!menu || menu.style.display === 'none') return;
  if (menu.contains(ev.target)) return;
  if (ev.target && ev.target.closest && ev.target.closest('[data-project-agent-more]')) return;
  _closeProjectAgentMenu();
}

function _onProjectAgentMenuKeyDown(ev) {
  if (ev.key === 'Escape') _closeProjectAgentMenu();
}

async function _removeProjectAgent(agentId) {
  if (!_projectDetailPid || !agentId) return;
  try {
    const res = await window.orkas.invoke('projects.bindings.remove', {
      projectId: _projectDetailPid,
      kind: 'agent',
      id: agentId,
    });
    if (res && res.ok === false) throw new Error(res.error || 'remove_failed');
    await loadProjectDetail(_projectDetailPid);
  } catch (err) {
    _projectDetailLog.warn('remove project agent failed', err);
  }
}

function _renderBindingsRows(kind, items) {
  const lang = _activeLang();
  const removeLabel = escapeHtml(t('project.bindings.remove'));
  const sorted = (items || []).slice().sort(_byDisplayName);
  const rows = [];
  for (const it of sorted) {
    const id = (kind === 'agent') ? it.agent_id : it.id;
    const name = escapeHtml(it.name || id);
    const desc = kind === 'agent' ? '' : _pickItemDescription(it, lang);
    const descHtml = desc ? `<div class="project-binding-desc">${escapeHtml(desc)}</div>` : '';
    const sourceTag = _projectBindingSourceHtml(it.source, kind);
    // Agents carry an avatar (icon + color seeded by agent_id) — mirrors
    // the agents grid card chrome so a binding row reads as the same actor.
    // Skills don't have an avatar in the spec; we leave the slot empty.
    const avatarHtml = (kind === 'agent' && typeof renderAvatarHtml === 'function')
      ? renderAvatarHtml(it.icon, it.color, {
        size: 32, seed: it.agent_id, extraClass: 'project-binding-avatar',
      })
      : '';
    rows.push(`
      <div class="project-binding-row" data-kind="${kind}" data-id="${escapeHtml(id)}">
        ${avatarHtml}
        <div class="project-binding-main">
          <div class="project-binding-head">
            <span class="project-binding-name">${name}</span>
            ${sourceTag}
          </div>
          ${descHtml}
        </div>
        <button type="button" class="project-binding-remove" data-action="remove"
                title="${removeLabel}" aria-label="${removeLabel}">×</button>
      </div>
    `);
  }
  if (!rows.length) {
    const emptyKey = kind === 'agent' ? 'project.bindings.empty_agents' : 'project.bindings.empty_skills';
    return `<div class="empty" data-i18n="${emptyKey}">${escapeHtml(t(emptyKey))}</div>`;
  }
  return rows.join('');
}

function _isProjectLibraryVectorizableKind(kind) {
  return ['text', 'pdf', 'docx', 'image'].includes(String(kind || ''));
}

function _projectLibraryRel(node) {
  return String(node?.relPath || node?.name || '');
}

function _projectBasename(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _projectDirname(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : '';
}

function _projectJoinPath(dir, name) {
  const d = String(dir || '').replace(/\/+$/, '');
  const n = String(name || '').replace(/^\/+/, '');
  return d ? `${d}/${n}` : n;
}

function _flattenProjectLibraryFiles(nodes) {
  const out = [];
  const walk = (items) => {
    for (const node of items || []) {
      if (!node) continue;
      if (node.type === 'dir') walk(node.children || []);
      else out.push(node);
    }
  };
  walk(nodes || []);
  return out;
}

function _sortProjectLibraryNodes(nodes) {
  return (nodes || []).slice().sort((a, b) => {
    const at = a?.type === 'dir';
    const bt = b?.type === 'dir';
    if (at !== bt) return at ? -1 : 1;
    const an = a?.name || _projectBasename(_projectLibraryRel(a));
    const bn = b?.name || _projectBasename(_projectLibraryRel(b));
    return an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true });
  });
}

function _buildProjectKbStatusMap(files, statusRows) {
  const next = {};
  for (const row of statusRows || []) {
    const name = row?.name || row?.path;
    if (!name) continue;
    next[name] = {
      status: row.status,
      chunks: row.chunks,
      error: row.error,
      kind: row.kind,
    };
  }
  for (const file of files || []) {
    const name = _projectLibraryRel(file);
    if (!name || !_isProjectLibraryVectorizableKind(file.kind)) continue;
    if (!next[name]) next[name] = { status: 'pending', kind: file.kind };
  }
  return next;
}

function _hasActiveProjectKbStatuses() {
  return Object.values(_projectKbStatusByName || {}).some((st) =>
    st && (st.status === 'pending' || st.status === 'processing'));
}

function _hasPendingProjectKbStatuses() {
  return Object.values(_projectKbStatusByName || {}).some((st) =>
    st && st.status === 'pending');
}

async function _refreshProjectKbStatusSnapshot(pid) {
  if (!pid || pid !== _projectDetailPid) return;
  const res = await window.orkas.invoke('projects.files.status', { projectId: pid, skipReconcile: true });
  if (!res?.ok || pid !== _projectDetailPid) return;
  const flatFiles = _flattenProjectLibraryFiles(_projectDetailMeta?.files || []);
  _projectKbStatusByName = _buildProjectKbStatusMap(flatFiles, res.files || []);
  for (const file of flatFiles) {
    const name = _projectLibraryRel(file);
    if (name) _updateProjectFileKbChip(name);
  }
}

function _kickProjectKbReconcileIfNeeded() {
  if (_projectKbReconcileInFlight || !_hasPendingProjectKbStatuses()) return;
  const pid = _projectDetailPid;
  if (!pid) return;
  _projectKbReconcileInFlight = true;
  window.orkas.invoke('projects.files.reconcile', { projectId: pid })
    .then(() => _refreshProjectKbStatusSnapshot(pid))
    .catch((err) => _projectDetailLog.warn('project kb reconcile failed', err))
    .finally(() => {
      _projectKbReconcileInFlight = false;
      _scheduleProjectKbStatusRefreshIfNeeded();
    });
}

function _scheduleProjectKbStatusRefreshIfNeeded() {
  if (_projectKbStatusRefreshTimer || !_hasActiveProjectKbStatuses()) return;
  if (typeof currentView !== 'undefined' && currentView !== 'project') return;
  const pid = _projectDetailPid;
  _projectKbStatusRefreshTimer = setTimeout(async () => {
    _projectKbStatusRefreshTimer = null;
    if (!pid || pid !== _projectDetailPid) return;
    if (typeof currentView !== 'undefined' && currentView !== 'project') return;
    try { await _refreshProjectKbStatusSnapshot(pid); }
    catch (err) { _projectDetailLog.warn('project kb status refresh failed', err); }
    if (_hasActiveProjectKbStatuses()) {
      _kickProjectKbReconcileIfNeeded();
      _scheduleProjectKbStatusRefreshIfNeeded();
    }
  }, 2000);
}

function _projectKbStatusChipHtml(name) {
  const st = _projectKbStatusByName[name];
  if (!st) return '';
  if (st.status === 'ready') return '';
  if (st.status === 'processing' || st.status === 'pending') {
    const label = st.status === 'pending' ? t('contexts.kb.pending') : t('contexts.kb.processing');
    return `<span class="ctx-kb-chip is-processing" title="${escapeHtml(label)}"><span class="ctx-kb-spinner"></span></span>`;
  }
  if (st.status === 'failed') {
    const err = st.error ? `${t('contexts.kb.failed')}: ${st.error}` : t('contexts.kb.failed');
    return `<span class="ctx-kb-chip is-failed" data-action="project-file-reprocess" title="${escapeHtml(err)}">!</span>`;
  }
  return '';
}

function _findProjectFileRow(name) {
  const rows = document.querySelectorAll('.project-file-row[data-project-file]');
  for (const row of rows) {
    if ((row.dataset.projectFile || '') === name) return row;
  }
  return null;
}

function _findProjectDirRow(name) {
  const rows = document.querySelectorAll('.project-dir-row[data-project-dir]');
  for (const row of rows) {
    if ((row.dataset.projectDir || '') === name) return row;
  }
  return null;
}

function _renderProjectFiles(files) {
  const list = document.getElementById('project-files-list');
  const status = document.getElementById('project-files-status');
  if (!list) return;
  if (status) {
    status.textContent = '';
    status.style.display = 'none';
  }
  const nodes = Array.isArray(files) ? files : [];
  _setCardCount('project-detail-files-count', _flattenProjectLibraryFiles(nodes).length);
  if (!nodes.length) {
    list.innerHTML = `<div class="empty" data-i18n="project.files.empty">${escapeHtml(t('project.files.empty'))}</div>`;
    if (_projectLibraryActiveName) _clearProjectLibraryViewer();
    return;
  }
  const flatFiles = _flattenProjectLibraryFiles(nodes);
  list.innerHTML = _renderProjectFileNodes(nodes);
  if (_projectLibraryActiveName && !flatFiles.some((f) => _projectLibraryRel(f) === _projectLibraryActiveName)) {
    _clearProjectLibraryViewer();
  }
}

function _renderProjectFileNodes(nodes, depth = 0) {
  const moreLabel = escapeHtml(t('contexts.menu.more_actions'));
  const indent = 10 + depth * 14;
  return _sortProjectLibraryNodes(nodes).map((f) => {
    const rel = _projectLibraryRel(f);
    const name = f.name || _projectBasename(rel);
    const label = escapeHtml(name);
    if (f.type === 'dir') {
      const open = _projectLibraryExpanded.has(rel);
      const caretCls = open ? 'skill-tree-caret' : 'skill-tree-caret collapsed';
      const icon = open
        ? _projectUiIconHtml('folder-open', 'skill-tree-node-svg')
        : _projectUiIconHtml('folder', 'skill-tree-node-svg');
      const childrenHtml = open
        ? `<div class="skill-tree-children">${_renderProjectFileNodes(f.children || [], depth + 1)}</div>`
        : '';
      return `
        <div class="ctx-tree-wrap project-dir-row" data-project-dir="${escapeHtml(rel)}" data-type="dir">
          <div class="skill-tree-node skill-tree-dir" style="padding-left:${indent}px">
            <span class="${caretCls}"></span>
            <span class="skill-tree-icon icon-folder">${icon}</span>
            <span class="skill-tree-label">${label}</span>
            <button type="button" class="ctx-row-menu-btn project-file-menu-btn" data-action="project-dir-menu"
                    title="${moreLabel}" aria-label="${moreLabel}">⋯</button>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    const chip = _projectKbStatusChipHtml(rel);
    const ext = _projectFileExt(name).replace(/^\./, '');
    const active = _projectLibraryActiveName === rel ? ' active' : '';
    return `
      <div class="ctx-tree-wrap project-file-row" data-project-file="${escapeHtml(rel)}" data-project-file-kind="${escapeHtml(f.kind || '')}" data-type="file">
        <div class="skill-tree-node skill-tree-file${active}" data-ext="${escapeHtml(ext)}" style="padding-left:${indent}px">
          <span class="skill-tree-caret skill-tree-caret-empty"></span>
          <span class="skill-tree-icon icon-file" data-ext="${escapeHtml(ext)}">${_projectUiIconHtml('file', 'skill-tree-node-svg')}</span>
          <span class="skill-tree-label">${label}</span>
          ${chip}
          <button type="button" class="ctx-row-menu-btn project-file-menu-btn" data-action="project-file-menu"
                  title="${moreLabel}" aria-label="${moreLabel}">⋯</button>
        </div>
      </div>
    `;
  }).join('');
}

function _bindProjectFileRows() {
  const root = document.getElementById('project-files-list');
  if (!root) return;
  root.querySelectorAll('.project-dir-row[data-project-dir]').forEach((row) => {
    const rel = row.dataset.projectDir || '';
    const node = row.querySelector(':scope > .skill-tree-node') || row;
    node.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="project-dir-menu"]')) {
        e.stopPropagation();
        _openProjectDirMenu(e.target.closest('[data-action="project-dir-menu"]'), rel);
        return;
      }
      e.stopPropagation();
      if (_projectLibraryExpanded.has(rel)) _projectLibraryExpanded.delete(rel);
      else _projectLibraryExpanded.add(rel);
      _renderProjectFiles(_projectDetailMeta?.files || []);
      _bindProjectFileRows();
      if (typeof hydrateUiIcons === 'function') hydrateUiIcons(document.getElementById('project-files-list'));
    });
  });
  root.querySelectorAll('.project-file-row[data-project-file]').forEach((row) => {
    const name = row.dataset.projectFile || '';
    const node = row.querySelector(':scope > .skill-tree-node') || row;
    node.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="project-file-menu"]')) {
        e.stopPropagation();
        _openProjectFileMenu(e.target.closest('[data-action="project-file-menu"]'), name);
        return;
      }
      if (e.target.closest('[data-action="project-file-reprocess"]')) {
        e.stopPropagation();
        await _reprocessProjectFile(name);
        return;
      }
      e.stopPropagation();
      await _openProjectFile(name);
    });
  });
}

async function _resolveProjectFilePath(name) {
  if (!_projectDetailPid || !name) return null;
  try {
    const res = await window.orkas.invoke('projects.files.absPath', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok || !res.path) throw new Error(res?.error || 'not_found');
    return res.path;
  } catch (err) {
    _projectDetailLog.warn('resolve project file failed', err);
    return null;
  }
}

async function _openProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  const row = _findProjectFileRow(name);
  const kind = row?.dataset?.projectFileKind || '';
  _projectLibraryActiveName = name;
  _markProjectLibraryActive();
  try {
    if (kind === 'text') return await _showProjectTextViewer(name);
    if (kind === 'image') return await _showProjectImageViewer(name);
    if (kind === 'pdf') return await _showProjectPdfViewer(name);
    if (kind === 'docx') return await _showProjectDocxViewer(name);
    return await _showProjectBinaryViewer(name, kind || 'other');
  } catch (err) {
    _projectDetailLog.warn('open project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.read_failed_with', { reason: err.message || err }));
  }
}

function _projectFileExt(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function _projectUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

function _projectChatMediaLocalUrl(absPath) {
  if (typeof _chatMediaLocalUrl === 'function') return _chatMediaLocalUrl(absPath);
  let p = String(absPath || '');
  if (p.includes('\\')) p = p.replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  return `chat-media://local/${encodeURI(p)}`;
}

function _markProjectLibraryActive() {
  document.querySelectorAll('#project-files-list .project-file-row').forEach((row) => {
    const active = (row.dataset.projectFile || '') === _projectLibraryActiveName;
    row.querySelector(':scope > .skill-tree-node')?.classList.toggle('active', active);
  });
}

function _prepProjectLibraryViewer(name) {
  if (_projectLibraryMveController) {
    try { _projectLibraryMveController.destroy(); } catch (_) { /* ignore */ }
    _projectLibraryMveController = null;
  }
  const modal = document.getElementById('project-library-viewer-modal');
  const empty = document.getElementById('project-library-editor-empty');
  const wrap = document.getElementById('project-library-viewer-wrap');
  const pathEl = document.getElementById('project-library-editor-path');
  if (!wrap) return null;
  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }
  if (empty) empty.style.display = 'none';
  wrap.style.display = 'flex';
  if (pathEl) pathEl.textContent = name;
  _markProjectLibraryActive();
  return {
    bodyEl: document.getElementById('project-library-viewer-body'),
    actionsEl: document.getElementById('project-library-viewer-actions'),
  };
}

function _clearProjectLibraryViewer() {
  if (_projectLibraryMveController) {
    try { _projectLibraryMveController.destroy(); } catch (_) { /* ignore */ }
    _projectLibraryMveController = null;
  }
  _projectLibraryActiveName = '';
  const modal = document.getElementById('project-library-viewer-modal');
  const empty = document.getElementById('project-library-editor-empty');
  const wrap = document.getElementById('project-library-viewer-wrap');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (empty) empty.style.display = 'flex';
  if (wrap) wrap.style.display = 'none';
  _markProjectLibraryActive();
}

async function _showProjectTextViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const res = await window.orkas.invoke('projects.files.readText', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  if (typeof mountMdViewEdit !== 'function') {
    els.bodyEl.innerHTML = `<pre class="ctx-viewer-pre">${escapeHtml(res.content || '')}</pre>`;
    els.actionsEl.innerHTML = '';
    return;
  }
  _projectLibraryMveController = mountMdViewEdit({
    bodyEl: els.bodyEl,
    actionsEl: els.actionsEl,
    source: { kind: 'project-file', projectId: _projectDetailPid, name },
    initialContent: res.content || '',
    initialDraft: _projectLibraryDrafts.get(name) || null,
    callbacks: {
      onDraftChange: (draft) => {
        if (draft === null) _projectLibraryDrafts.delete(name);
        else _projectLibraryDrafts.set(name, draft);
      },
      onReveal: () => _revealProjectFile(name),
      onDelete: () => _deleteProjectFileFromViewer(name),
      onSaved: async () => {
        _projectLibraryDrafts.delete(name);
        await loadProjectDetail(_projectDetailPid);
      },
    },
  });
  els.bodyEl.scrollTop = 0;
}

async function _showProjectImageViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const res = await window.orkas.invoke('projects.files.image', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  const src = `data:${res.mediaType};base64,${res.base64}`;
  const sizeKb = res.bytes ? ` · ${Math.round(res.bytes / 1024)}KB` : '';
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-image-wrap">
      <img class="ctx-viewer-image" src="${src}" alt="${escapeHtml(name)}"/>
      <div class="ctx-viewer-image-meta">${escapeHtml(name)}${sizeKb}</div>
    </div>
  `;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.scrollTop = 0;
}

async function _showProjectPdfViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const absPath = await _resolveProjectFilePath(name);
  if (!absPath) throw new Error('not_found');
  const src = _projectChatMediaLocalUrl(absPath);
  els.bodyEl.innerHTML = `<iframe class="ctx-viewer-pdf" src="${src}#toolbar=1&navpanes=0" title="${escapeHtml(name)}"></iframe>`;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
}

async function _showProjectDocxViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const res = await window.orkas.invoke('projects.files.docxHtml', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  els.bodyEl.innerHTML = `<div class="ctx-viewer-docx markdown-body">${res.html || `<p class="muted">${escapeHtml(t('contexts.viewer.docx_empty'))}</p>`}</div>`;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.scrollTop = 0;
}

async function _showProjectBinaryViewer(name, kind) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const kindLabel = t(`contexts.viewer.kind_${kind}`) || kind.toUpperCase();
  const icon = (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function')
    ? window.fileKindIconHtml(name, kind)
    : _projectUiIconHtml('file', 'chat-file-kind-icon');
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-binary">
      <div class="ctx-viewer-binary-icon">${icon}</div>
      <div class="ctx-viewer-binary-name">${escapeHtml(name)}</div>
      <div class="ctx-viewer-binary-hint">${escapeHtml(t('contexts.viewer.binary_hint', { kind: kindLabel }))}</div>
      <button class="btn btn-primary" id="project-viewer-reveal-big">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    </div>
  `;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.querySelector('#project-viewer-reveal-big')?.addEventListener('click', () => _revealProjectFile(name));
  await _revealProjectFile(name);
}

function _renderProjectLibraryViewerActions(actionsEl, name) {
  if (!actionsEl) return;
  actionsEl.innerHTML = `
    <button class="btn btn-sm" data-action="project-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" data-action="project-viewer-delete">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  actionsEl.querySelector('[data-action="project-viewer-reveal"]')?.addEventListener('click', () => _revealProjectFile(name));
  actionsEl.querySelector('[data-action="project-viewer-delete"]')?.addEventListener('click', () => _deleteProjectFileFromViewer(name));
}

async function _deleteProjectFileFromViewer(name) {
  await _deleteProjectFile(name);
}

async function _revealProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  const absPath = await _resolveProjectFilePath(name);
  if (!absPath) return;
  try {
    const res = await window.orkas.invoke('workspace.revealPath', {
      path: absPath,
      projectId: _projectDetailPid,
    });
    if (!res?.ok) throw new Error(res?.error || 'reveal_failed');
  } catch (err) {
    _projectDetailLog.warn('reveal project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.reveal_failed'));
  }
}

async function _reprocessProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  try {
    _projectKbStatusByName[name] = {
      ...(_projectKbStatusByName[name] || {}),
      status: 'pending',
    };
    _updateProjectFileKbChip(name);
    _scheduleProjectKbStatusRefreshIfNeeded();
    const res = await window.orkas.invoke('projects.files.reprocess', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok) throw new Error(res?.error || 'reprocess_failed');
  } catch (err) {
    _projectDetailLog.warn('reprocess project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.reprocess_failed'));
  }
}

async function _deleteProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  try {
    const res = await window.orkas.invoke('projects.files.delete', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok) throw new Error(res?.error || 'delete_failed');
    if (_projectLibraryActiveName === name || _projectLibraryActiveName.startsWith(`${name}/`)) {
      for (const key of Array.from(_projectLibraryDrafts.keys())) {
        if (key === name || key.startsWith(`${name}/`)) _projectLibraryDrafts.delete(key);
      }
      _clearProjectLibraryViewer();
    }
    _projectLibraryExpanded.delete(name);
    await loadProjectDetail(_projectDetailPid);
  } catch (err) {
    _projectDetailLog.warn('delete project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.delete_failed'));
  }
}

function _projectFileMenuItemsFor(name) {
  const row = _findProjectFileRow(name);
  const kind = row?.dataset?.projectFileKind || '';
  const items = [];
  if (kind === 'text') items.push({ action: 'edit', label: t('contexts.menu.edit') });
  items.push({ action: 'reveal', label: t('project.files.reveal') });
  items.push({ action: 'rename', label: t('contexts.menu.rename') });
  items.push({ action: 'delete', label: t('contexts.menu.delete'), danger: true });
  return items;
}

function _projectLibraryRootMenuItems() {
  return [
    { action: 'new_text', label: t('contexts.menu.new_text') },
    { action: 'new_folder', label: t('contexts.menu.new_folder') },
    { action: 'upload', label: t('contexts.menu.upload') },
  ];
}

function _projectDirMenuItemsFor() {
  return [
    { action: 'new_text', label: t('contexts.menu.new_text') },
    { action: 'new_folder', label: t('contexts.menu.new_folder') },
    { action: 'upload', label: t('contexts.menu.upload') },
    { action: 'rename', label: t('contexts.menu.rename') },
    { action: 'delete', label: t('contexts.menu.delete'), danger: true },
  ];
}

function _openProjectLibraryRootMenu(anchorBtn) {
  let menu = document.getElementById('project-file-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-file-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.kind === 'root' && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectFileMenu(); return; }
  _closeProjectFileMenu();
  menu.innerHTML = _projectLibraryRootMenuItems().map((it) =>
    `<div class="ctx-row-menu-item" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.dataset.kind = 'root';
  anchorBtn.closest('.contexts-section-header')?.classList.add('is-menu-open');
  _positionProjectFileMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectFileMenu();
      await _runProjectLibraryRootAction(action);
    });
  }
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectFileMenuOutside, true);
    document.addEventListener('keydown', _onProjectFileMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectFileMenu, { once: true });
  }, 0);
}

function _openProjectFileMenu(anchorBtn, name) {
  let menu = document.getElementById('project-file-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-file-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.fileName === name && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectFileMenu(); return; }
  _closeProjectFileMenu();

  const items = _projectFileMenuItemsFor(name);
  menu.innerHTML = items.map((it) =>
    `<div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.dataset.fileName = name;
  delete menu.dataset.dirName;

  const srcRow = anchorBtn.closest('.project-file-row');
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
  if (srcRow) srcRow.classList.add('is-menu-open');

  _positionProjectFileMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectFileMenu();
      await _runProjectFileMenuAction(action, name);
    });
  }
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectFileMenuOutside, true);
    document.addEventListener('keydown', _onProjectFileMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectFileMenu, { once: true });
  }, 0);
}

function _openProjectDirMenu(anchorBtn, name) {
  let menu = document.getElementById('project-file-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-file-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.dirName === name && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectFileMenu(); return; }
  _closeProjectFileMenu();

  const items = _projectDirMenuItemsFor(name);
  menu.innerHTML = items.map((it) =>
    `<div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>`
  ).join('');
  menu.dataset.dirName = name;
  delete menu.dataset.fileName;

  const srcRow = anchorBtn.closest('.project-dir-row');
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
  if (srcRow) srcRow.classList.add('is-menu-open');

  _positionProjectFileMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectFileMenu();
      await _runProjectDirMenuAction(action, name);
    });
  }
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectFileMenuOutside, true);
    document.addEventListener('keydown', _onProjectFileMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectFileMenu, { once: true });
  }, 0);
}

function _positionProjectFileMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}

function _closeProjectFileMenu() {
  const menu = document.getElementById('project-file-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.fileName;
    delete menu.dataset.dirName;
    delete menu.dataset.kind;
  }
  document.querySelectorAll('.project-file-row.is-menu-open, .project-dir-row.is-menu-open')
    .forEach((row) => row.classList.remove('is-menu-open'));
  document.querySelectorAll('#project-library-root-menu-btn')
    .forEach((btn) => btn.closest('.contexts-section-header')?.classList.remove('is-menu-open'));
  document.removeEventListener('mousedown', _onProjectFileMenuOutside, true);
  document.removeEventListener('keydown', _onProjectFileMenuKeyDown, true);
  window.removeEventListener('resize', _closeProjectFileMenu);
}

function _onProjectFileMenuOutside(ev) {
  const menu = document.getElementById('project-file-row-menu');
  if (!menu || menu.style.display === 'none') return;
  if (menu.contains(ev.target)) return;
  if (ev.target && ev.target.closest && ev.target.closest('.project-file-menu-btn, #project-library-root-menu-btn')) return;
  _closeProjectFileMenu();
}

function _onProjectFileMenuKeyDown(ev) {
  if (ev.key === 'Escape') _closeProjectFileMenu();
}

async function _runProjectFileMenuAction(action, name) {
  if (action === 'open') await _openProjectFile(name);
  else if (action === 'edit') await _editProjectFile(name);
  else if (action === 'reveal') await _revealProjectFile(name);
  else if (action === 'rename') await _renameProjectFile(name);
  else if (action === 'delete') await _deleteProjectFile(name);
}

async function _runProjectDirMenuAction(action, name) {
  if (action === 'upload') {
    await _uploadProjectFilesNative(name || '');
    return;
  }
  if (action === 'new_text') await _createProjectTextFile(name);
  else if (action === 'new_folder') await _createProjectDir(name);
  else if (action === 'rename') await _renameProjectFile(name);
  else if (action === 'delete') await _deleteProjectFile(name);
}

async function _runProjectLibraryRootAction(action) {
  if (action === 'upload') {
    await _uploadProjectFilesNative('');
    return;
  }
  if (action === 'new_text') {
    await _createProjectTextFile('');
  }
  if (action === 'new_folder') {
    await _createProjectDir('');
  }
}

async function _createProjectTextFile(parentDir = '') {
  if (!_projectDetailPid) return;
  const stem = t('contexts.new.untitled_stem');
  const fullPath = _projectJoinPath(parentDir, `${stem}.md`);
  try {
    const res = await window.orkas.invoke('projects.files.createText', {
      projectId: _projectDetailPid,
      name: fullPath,
    });
    if (!res?.ok) throw new Error(res?.error || 'create_failed');
    const name = res.info?.relPath || res.info?.name || fullPath;
    if (parentDir) _projectLibraryExpanded.add(parentDir);
    _projectLibraryActiveName = name;
    await loadProjectDetail(_projectDetailPid);
    await _openProjectFile(name);
    if (_projectLibraryMveController) _projectLibraryMveController.setMode('edit');
  } catch (err) {
    _projectDetailLog.warn('create project text failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.file.create_failed'));
  }
}

async function _createProjectDir(parentDir = '') {
  if (!_projectDetailPid || typeof uiPrompt !== 'function') return;
  const nameRaw = (await uiPrompt(t('contexts.menu.new_folder'), '') || '').trim();
  if (!nameRaw) return;
  if (nameRaw.includes('/') || nameRaw.includes('..') || nameRaw.includes('\\')) {
    if (typeof uiAlert === 'function') await uiAlert(t('contexts.new.bad_chars'));
    return;
  }
  const rel = _projectJoinPath(parentDir, nameRaw);
  try {
    const res = await window.orkas.invoke('projects.files.mkdir', {
      projectId: _projectDetailPid,
      path: rel,
    });
    if (!res?.ok) throw new Error(res?.error || 'create_failed');
    if (parentDir) _projectLibraryExpanded.add(parentDir);
    _projectLibraryExpanded.add(res.path || rel);
    await loadProjectDetail(_projectDetailPid);
  } catch (err) {
    _projectDetailLog.warn('create project folder failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.dir.create_failed'));
  }
}

async function _editProjectFile(name) {
  if (!name) return;
  await _openProjectFile(name);
  if (_projectLibraryMveController) _projectLibraryMveController.setMode('edit');
}

async function _renameProjectFile(name) {
  if (!_projectDetailPid || !name || typeof uiPrompt !== 'function') return;
  const base = _projectBasename(name);
  const parentDir = _projectDirname(name);
  const nextBase = (await uiPrompt(t('project.files.rename_prompt'), base) || '').trim();
  if (!nextBase || nextBase === base) return;
  const next = nextBase.includes('/') ? nextBase : _projectJoinPath(parentDir, nextBase);
  try {
    const res = await window.orkas.invoke('projects.files.rename', {
      projectId: _projectDetailPid,
      oldName: name,
      name: next,
    });
    if (!res?.ok) throw new Error(res?.error || 'rename_failed');
    const actual = res.name || next;
    for (const [key, val] of Array.from(_projectLibraryDrafts.entries())) {
      if (key === name) {
        _projectLibraryDrafts.set(actual, val);
        _projectLibraryDrafts.delete(key);
      } else if (key.startsWith(`${name}/`)) {
        _projectLibraryDrafts.set(`${actual}${key.slice(name.length)}`, val);
        _projectLibraryDrafts.delete(key);
      }
    }
    if (_projectLibraryExpanded.has(name)) {
      _projectLibraryExpanded.delete(name);
      _projectLibraryExpanded.add(actual);
    }
    if (_projectLibraryActiveName === name || _projectLibraryActiveName.startsWith(`${name}/`)) {
      _projectLibraryActiveName = `${actual}${_projectLibraryActiveName.slice(name.length)}`;
      const pathEl = document.getElementById('project-library-editor-path');
      if (pathEl) pathEl.textContent = _projectLibraryActiveName;
      if (_projectLibraryMveController?.setSource) {
        _projectLibraryMveController.setSource({ kind: 'project-file', projectId: _projectDetailPid, name: _projectLibraryActiveName });
      }
    }
    await loadProjectDetail(_projectDetailPid);
  } catch (err) {
    _projectDetailLog.warn('rename project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.entry.rename_failed'));
  }
}

function _updateProjectFileKbChip(name) {
  const row = _findProjectFileRow(name);
  if (!row) return;
  const existing = row.querySelector('.ctx-kb-chip');
  const html = _projectKbStatusChipHtml(name);
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
  } else if (html) {
    const menuBtn = row.querySelector('.project-file-menu-btn');
    if (menuBtn) menuBtn.insertAdjacentHTML('beforebegin', html);
  }
  row.querySelector('[data-action="project-file-reprocess"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await _reprocessProjectFile(name);
  });
}

function _applyProjectKbEvent(ev) {
  if (!ev || ev.projectId !== _projectDetailPid) return;
  const name = ev.name || ev.relPath;
  if (!name) return;
  if (ev.status === 'deleted') {
    delete _projectKbStatusByName[name];
  } else {
    _projectKbStatusByName[name] = {
      status: ev.status,
      ...(ev.chunks != null ? { chunks: ev.chunks } : {}),
      ...(ev.error ? { error: ev.error } : {}),
      ...(ev.kind ? { kind: ev.kind } : {}),
    };
  }
  _updateProjectFileKbChip(name);
  _scheduleProjectKbStatusRefreshIfNeeded();
}

function _ensureProjectKbEventSubscription(pid) {
  if (!pid || !window.orkas || typeof window.orkas.stream !== 'function') return;
  if (_projectKbEventsHandle && _projectKbEventsPid === pid) return;
  _stopProjectKbEventSubscription();
  _projectKbEventsPid = pid;
  try {
    _projectKbEventsHandle = window.orkas.stream('project.kb.events', { projectId: pid }, (msg) => {
      if (msg?.type === 'event' && msg.event) _applyProjectKbEvent(msg.event);
    });
    _projectKbEventsHandle.promise.catch(() => {
      /* stream closes on navigation/cancel */
    }).finally(() => {
      if (_projectKbEventsPid === pid) {
        _projectKbEventsHandle = null;
        _projectKbEventsPid = '';
      }
    });
  } catch (err) {
    _projectDetailLog.warn('subscribe project kb events failed', err);
    _projectKbEventsHandle = null;
    _projectKbEventsPid = '';
  }
}

function _stopProjectKbEventSubscription() {
  try { _projectKbEventsHandle?.cancel?.(); } catch { /* ignore */ }
  _projectKbEventsHandle = null;
  _projectKbEventsPid = '';
}

function _arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf || new ArrayBuffer(0));
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

function _setProjectFilesStatus(text) {
  const status = document.getElementById('project-files-status');
  if (!status) return;
  const body = text || '';
  status.textContent = body;
  status.style.display = body ? '' : 'none';
}

async function _uploadProjectFiles(fileList, targetDir = '') {
  if (!_projectDetailPid || !fileList || !fileList.length) return;
  const files = Array.from(fileList).filter(Boolean);
  if (!files.length) return;
  if (targetDir) _projectLibraryExpanded.add(targetDir);
  _setProjectFilesStatus(t('project.files.uploading'));
  const failed = [];
  await Promise.all(files.map(async (file) => {
    try {
      const buf = await file.arrayBuffer();
      const targetName = _projectJoinPath(targetDir, file.name || 'file');
      const res = await window.orkas.invoke('projects.files.upload', {
        projectId: _projectDetailPid,
        name: targetName,
        data: _arrayBufferToBase64(buf),
      });
      if (!res?.ok) {
        failed.push(t('project.files.upload_failed', {
          name: file.name || 'file',
          reason: res?.error || t('chat.attach_upload_generic_fail'),
        }));
      }
    } catch (err) {
      failed.push(t('project.files.upload_failed', {
        name: file.name || 'file',
        reason: err?.message || t('chat.attach_upload_generic_fail'),
      }));
    }
  }));
  await loadProjectDetail(_projectDetailPid);
  if (failed.length && typeof uiAlert === 'function') {
    await uiAlert(t('project.files.upload_failed_list', { list: failed.join('\n') }));
  }
}

async function _uploadProjectFilesNative(targetDir = '') {
  if (!_projectDetailPid) return;
  if (targetDir) _projectLibraryExpanded.add(targetDir);
  _setProjectFilesStatus(t('project.files.uploading'));
  let data;
  try {
    data = await window.orkas.invoke('projects.files.pickAndUpload', {
      projectId: _projectDetailPid,
      targetDir,
    });
  } catch (err) {
    _setProjectFilesStatus('');
    if (typeof uiAlert === 'function') {
      await uiAlert(t('project.files.upload_failed_list', { list: err?.message || String(err) }));
    }
    return;
  }
  _setProjectFilesStatus('');
  await loadProjectDetail(_projectDetailPid);
  const failed = (Array.isArray(data && data.files) ? data.files : []).filter((r) => !r || r.ok === false);
  if (failed.length && typeof uiAlert === 'function') {
    const list = failed.map((r) => t('project.files.upload_failed', {
      name: r.name || 'file',
      reason: r.error || t('chat.attach_upload_generic_fail'),
    })).join('\n');
    await uiAlert(t('project.files.upload_failed_list', { list }));
  }
}

async function _submitProjectChat() {
  if (!_projectDetailPid) return;
  const input = document.getElementById('project-chat-input');
  const btn = document.getElementById('project-chat-send-btn');
  const raw = (input?.value || '').trim();
  if (!raw) return;
  if (typeof ensureModelConfigured === 'function' && !ensureModelConfigured()) return;
  const useSelection = (typeof consumeChatUseSelection === 'function')
    ? consumeChatUseSelection('project')
    : null;
  const recipient = (typeof getChatRecipient === 'function')
    ? getChatRecipient('project')
    : null;
  const withUse = (typeof transformWithChatUse === 'function')
    ? transformWithChatUse(raw, useSelection)
    : raw;
  const content = (typeof applyRecipientPrefix === 'function')
    ? applyRecipientPrefix(withUse, 'project')
    : withUse;
  if (btn) btn.disabled = true;
  let convId = '';
  try {
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'normal', projectId: _projectDetailPid }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('chat.create_conv_failed'));
    const conv = data.conversation;
    convId = conv.conversation_id;
    conv.title = (typeof _autoTitle === 'function') ? _autoTitle(raw) : raw.slice(0, 32);
    conversations.unshift(conv);
    renderConversationList();
    if (typeof loadProjects === 'function') loadProjects(true);
  } catch (err) {
    if (typeof uiAlert === 'function') {
      await uiAlert(t('chat.create_conv_failed_with_reason', { reason: err?.message || err }));
    }
    if (btn) btn.disabled = false;
    return;
  }

  if (input) {
    input.value = '';
    if (typeof autoGrow === 'function') autoGrow(input, 180);
  }
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.value = '';
    if (typeof autoGrow === 'function') autoGrow(chatInput, 200);
  }
  if (typeof setView === 'function') setView('conversation', convId, { skipLoad: true });
  if (recipient && typeof setChatRecipient === 'function') {
    setChatRecipient('conversation', recipient);
  }
  if (useSelection && typeof setChatUseSelection === 'function') {
    setChatUseSelection('conversation', useSelection);
  }
  if (btn) btn.disabled = false;
  if (typeof sendInCurrentConversation === 'function') {
    await sendInCurrentConversation(content);
  }
}

function _activeLang() {
  if (typeof getLang === 'function') return getLang();
  return 'en';
}

/** Stable A→Z order by display name (case + diacritic insensitive,
 *  numeric-aware so "Item 2" precedes "Item 10"). Falls back to id when
 *  a name is missing. Used in both the bound-items rail and the candidate
 *  picker so user-facing lists stay legible regardless of insertion
 *  order. zh + en mix sorts reasonably under default locale collation. */
function _byDisplayName(a, b) {
  const na = (a && (a.name || a.agent_id || a.id)) || '';
  const nb = (b && (b.name || b.agent_id || b.id)) || '';
  return na.localeCompare(nb, undefined, { sensitivity: 'base', numeric: true });
}

function _pickItemDescription(item, lang) {
  // Centralised across the renderer: `utils.js::pickDesc` does the
  // cross-locale fallback (zh ?? en ?? '') so a one-language entry never
  // renders blank. Don't duplicate the rule here.
  return (typeof pickDesc === 'function') ? pickDesc(item, lang) : '';
}

function _projectBindingSourceHtml(source, kind) {
  if (!source) return '';
  const label = (typeof catalogSourceLabel === 'function')
    ? catalogSourceLabel(source, kind === 'skill' ? 'skills' : 'agents')
    : String(source);
  if (!label) return '';
  const normalized = (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source);
  return `<span class="project-binding-source project-binding-source--${escapeHtml(normalized)}">${escapeHtml(label)}</span>`;
}

function _bindRemoveButtons() {
  document.querySelectorAll('#project-detail-content [data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.project-binding-row');
      if (!row) return;
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      try {
        await window.orkas.invoke('projects.bindings.remove', {
          projectId: _projectDetailPid, kind, id,
        });
        await loadProjectDetail(_projectDetailPid);
      } catch (err) {
        _projectDetailLog.warn('remove binding failed', err);
      }
    });
  });
}

// ── Add picker (centered modal with search) ───────────────────────────

async function _openAddPicker(kind) {
  // Dispose any previously-open picker so re-clicks don't stack.
  document.getElementById('project-binding-picker-overlay')?.remove();

  let candidates;
  try {
    const res = await window.orkas.invoke('projects.bindings.candidates', {
      projectId: _projectDetailPid,
    });
    if (!res?.ok) throw new Error(res?.error || 'load_failed');
    candidates = ((kind === 'agent') ? (res.agents || []) : (res.skills || [])).slice().sort(_byDisplayName);
  } catch (err) {
    _projectDetailLog.warn('load candidates failed', err);
    return;
  }

  const titleKey = kind === 'agent' ? 'project.bindings.picker_title_agents' : 'project.bindings.picker_title_skills';
  const emptyKey = kind === 'agent' ? 'project.bindings.candidates_empty_agents' : 'project.bindings.candidates_empty_skills';
  const closeText = escapeHtml(t('project.bindings.picker_close'));
  const searchPh = escapeHtml(t('project.bindings.picker_search_placeholder'));

  const overlay = document.createElement('div');
  overlay.id = 'project-binding-picker-overlay';
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal project-binding-picker-modal" role="dialog" aria-modal="true">
      <div class="project-binding-picker-header">
        <span class="project-binding-picker-title" data-i18n="${titleKey}">${escapeHtml(t(titleKey))}</span>
        <button type="button" class="project-binding-picker-close" data-action="close" aria-label="${closeText}">×</button>
      </div>
      <div class="project-binding-picker-search">
        <input type="text" id="project-binding-picker-search-input"
               placeholder="${searchPh}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="project-binding-picker-body">
        <div class="project-binding-picker-list" id="project-binding-picker-list"></div>
        <div class="empty muted" id="project-binding-picker-empty" style="display:none"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#project-binding-picker-list');
  const emptyEl = overlay.querySelector('#project-binding-picker-empty');
  const searchEl = overlay.querySelector('#project-binding-picker-search-input');

  // Render current candidate set, applying the search filter. Re-rendered
  // on every keystroke + after each successful add.
  const render = () => {
    const lang = _activeLang();
    const q = (searchEl.value || '').trim().toLocaleLowerCase();
    const filtered = !q ? candidates : candidates.filter((c) => {
      const id = (kind === 'agent') ? c.agent_id : c.id;
      const name = (c.name || '').toLocaleLowerCase();
      const desc = (_pickItemDescription(c, lang) || '').toLocaleLowerCase();
      return name.includes(q) || desc.includes(q) || (id || '').toLocaleLowerCase().includes(q);
    });
    if (!filtered.length) {
      listEl.innerHTML = '';
      const noMatch = q ? t('project.bindings.picker_no_match') : t(emptyKey);
      emptyEl.textContent = noMatch;
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = filtered.map((c) => {
      const id = (kind === 'agent') ? c.agent_id : c.id;
      const name = escapeHtml(c.name || id);
      const desc = _pickItemDescription(c, lang);
      const descHtml = desc ? `<div class="project-binding-desc muted">${escapeHtml(desc)}</div>` : '';
      const source = _projectBindingSourceHtml(c.source, kind);
      return `
        <div class="project-binding-picker-item" data-kind="${kind}" data-id="${escapeHtml(id)}">
          <div class="project-binding-main">
            <div class="project-binding-head">
              <span class="project-binding-name">${name}</span>
              ${source}
            </div>
            ${descHtml}
          </div>
          <button type="button" class="btn btn-sm" data-action="pick" aria-label="Add">+</button>
        </div>
      `;
    }).join('');
    // Only the `+` button adds — clicking the row body itself is a no-op
    // (per design: explicit confirm, no accidental adds when scanning the
    // description).
    listEl.querySelectorAll('.project-binding-picker-item [data-action="pick"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('.project-binding-picker-item');
        if (!row) return;
        const id = row.dataset.id;
        const k = row.dataset.kind;
        try {
          const res = await window.orkas.invoke('projects.bindings.add', {
            projectId: _projectDetailPid, kind: k, id,
          });
          if (!res?.ok) throw new Error(res?.error || 'add_failed');
          // Drop the picked id from the local candidate set so it
          // disappears from subsequent renders without a server round-trip.
          candidates = candidates.filter((c) => {
            const cid = (k === 'agent') ? c.agent_id : c.id;
            return cid !== id;
          });
          render();
          // Background refresh of the detail page list so newly-bound
          // items appear in the rail behind the modal.
          loadProjectDetail(_projectDetailPid).catch((err) => _projectDetailLog.warn('refresh failed', err));
        } catch (err) {
          _projectDetailLog.warn('add binding failed', err);
        }
      });
    });
  };

  searchEl.addEventListener('input', render);
  searchEl.addEventListener('keydown', (e) => {
    // IME guard (CLAUDE.md §8) — Esc while composing should commit the
    // candidate, not close the modal.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && document.activeElement !== searchEl) close();
  };
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  render();
  setTimeout(() => searchEl.focus(), 0);
}

// ── Header actions: Rename / Delete ────────────────────────────────────

function _onRenameAction() {
  if (!_projectDetailMeta) return;
  const titleEl = document.getElementById('project-detail-title');
  const inputEl = document.getElementById('project-detail-title-input');
  if (!titleEl || !inputEl) return;
  inputEl.value = _projectDetailMeta.project?.name || '';
  _setProjectDetailRenameMode(true);
  inputEl.focus();
  inputEl.select();
}

async function _commitRename(newName) {
  if (!_projectDetailPid || !_projectDetailMeta) return;
  const old = _projectDetailMeta.project?.name || '';
  let trimmed = String(newName || '').trim();
  if (typeof window.limitNameDisplayText === 'function') trimmed = window.limitNameDisplayText(trimmed);
  // No change OR empty → revert silently.
  if (!trimmed || trimmed === old) {
    _exitRenameMode();
    return;
  }
  let code = '';
  try {
    const res = await window.orkas.invoke('projects.rename', {
      projectId: _projectDetailPid, name: trimmed,
    });
    if (!res || !res.ok) {
      code = (res && res.error) || 'generic';
    } else {
      _projectDetailMeta.project = res.project;
      if (typeof loadProjects === 'function') loadProjects(true);
      _exitRenameMode();
      _renderProjectDetail();
      return;
    }
  } catch (err) {
    code = (err && err.message) || 'generic';
  }
  if (code === 'name_dup') {
    await uiAlert(t('project.name_dup_inline'));
  } else if (code === 'name_empty') {
    await uiAlert(t('project.name_empty'));
  } else if (code) {
    await uiAlert(t('project.error.generic'));
  }
  _exitRenameMode();
}

function _exitRenameMode() {
  _setProjectDetailRenameMode(false);
}

function _setProjectDetailRenameMode(on) {
  const titleEl = document.getElementById('project-detail-title');
  const inputEl = document.getElementById('project-detail-title-input');
  const countEl = document.getElementById('project-detail-header-count');
  const renameBtn = document.getElementById('project-action-rename');
  const deleteBtn = document.getElementById('project-action-delete');
  if (titleEl) titleEl.style.display = on ? 'none' : '';
  if (inputEl) inputEl.style.display = on ? '' : 'none';
  if (countEl) countEl.style.display = on ? 'none' : '';
  if (renameBtn) {
    renameBtn.textContent = on ? t('project.action.done') : t('project.action.rename');
    renameBtn.setAttribute('data-rename-mode', on ? '1' : '0');
  }
  if (deleteBtn) deleteBtn.style.display = on ? 'none' : '';
}

function _isProjectDetailRenameMode() {
  const inputEl = document.getElementById('project-detail-title-input');
  return !!inputEl && inputEl.style.display !== 'none';
}

async function _onDeleteAction() {
  if (!_projectDetailPid || !_projectDetailMeta) return;
  // Reuse the sidebar's delete confirm flow so the danger label / count
  // wording stays in one place. `_confirmDeleteProject` is defined in
  // `projects.js` and runs the IPC + post-delete cleanup. The sidebar
  // handler doesn't navigate away on its own when the user is on the
  // project detail panel (currentCid is null there), so we check post-hoc:
  // if the project disappeared from the cache, jump to new-chat.
  const targetPid = _projectDetailPid;
  if (typeof _confirmDeleteProject === 'function') {
    await _confirmDeleteProject(targetPid);
  }
  const stillExists = Array.isArray(_projectsCache)
    && _projectsCache.some((p) => p && p.project_id === targetPid);
  if (!stillExists && currentView === 'project') {
    if (typeof setView === 'function') setView('new-chat');
  }
}

// Kept as a no-op compatibility hook because conversation.js calls it after
// loading history. Empty project-agent guidance now lives only on the project
// detail page's Agents module.
async function refreshConvProjectEmptyBanner(_cid) {
  return undefined;
}

// ── Boot wiring ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('project-add-agent-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openAddPicker('agent');
  });
  document.getElementById('project-action-rename')?.addEventListener('mousedown', (e) => {
    if (_isProjectDetailRenameMode()) e.preventDefault();
  });
  document.getElementById('project-action-rename')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const inputEl = document.getElementById('project-detail-title-input');
    if (_isProjectDetailRenameMode() && inputEl) _commitRename(inputEl.value);
    else _onRenameAction();
  });
  document.getElementById('project-action-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onDeleteAction();
  });
  document.getElementById('project-library-root-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openProjectLibraryRootMenu(e.currentTarget);
  });
  const projectLibraryViewerModal = document.getElementById('project-library-viewer-modal');
  projectLibraryViewerModal?.querySelector('[data-action="project-library-viewer-close"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _clearProjectLibraryViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Escape') return;
    if (projectLibraryViewerModal?.classList.contains('open')) {
      _clearProjectLibraryViewer();
      e.preventDefault();
    }
  });
  document.getElementById('project-chat-attach-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _uploadProjectFilesNative('');
  });
  const projectInput = document.getElementById('project-chat-input');
  if (projectInput) {
    projectInput.addEventListener('input', () => {
      if (typeof autoGrow === 'function') autoGrow(projectInput, 180);
    });
    projectInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (_handleModifiedComposerEnter(e)) return;
      if (_isPlainComposerEnter(e)) {
        e.preventDefault();
        _submitProjectChat();
      }
    });
  }
  document.getElementById('project-chat-send-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _submitProjectChat();
  });
  // Inline rename input handlers.
  const inputEl = document.getElementById('project-detail-title-input');
  if (inputEl) {
    if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(inputEl);
    inputEl.addEventListener('keydown', (e) => {
      // IME guard (CLAUDE.md §8) — Enter while composing must commit
      // the candidate, not the rename.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); _commitRename(inputEl.value); }
      else if (e.key === 'Escape') { e.preventDefault(); _exitRenameMode(); }
    });
    inputEl.addEventListener('blur', () => _commitRename(inputEl.value));
  }
  window.addEventListener('i18n-change', () => {
    if (currentView === 'project' && _projectDetailMeta) _renderProjectDetail();
  });
});
